import * as formdata from 'form-data';
import * as util from 'util';
import * as console from 'console';
import * as fs from 'fs';
import { parseString } from 'xml2js';
import * as _ from 'lodash';
import * as request from 'request-promise';

export interface Property {
    name: string;
    value: string;

}

export interface Server {
    host: string,
    username: string,
    password: string,
    port: number,
    cookie?: string
}

export interface ProcessNode {
    filePath: string,
    rootNode: string,
    uploadPath: string,
    shouldDelete: boolean
}

export class Sling2JCR {
    ready: Promise<Server[]>;
    logger: any;

    constructor(private servers: Server[], logger?: any) {
        this.ready = this.loginAll(servers);

        this.logger = logger || {
            info: console.log,
            error: console.error,
            warn: console.warn
        };
    }

    private logJSONResponse(response: any) {
        try {
            if (typeof response === "string") {
                response = JSON.parse(response);
            }else if(typeof response === "object"){
                response = JSON.parse(response.error)
            }
            this.logger.info(`${response['status.code']} ${response['status.message']} : ${response.title}`);
        } catch (error) {
            this.logger.error(response);
        }
    }

    private async login(server: Server, retry?: boolean): Promise<Server> {
        return new Promise<Server>((resolve, reject) => {
            var form = `j_username=${server.username}&j_password=${server.password}&j_workspace=crx.default&j_validate=true&_charset_=utf-8`;
            request.post({
                url: server.host + ":" + server.port + "/crx/de/j_security_check",
                method: 'POST',
                form: form,
                resolveWithFullResponse: true
            }).then(response => {
                let cookie = response.headers['set-cookie'][0];
                server.cookie = cookie;
                this.logger.info(`Cookie for server: ${server.host}:${server.port} is ${cookie}`);
                resolve(server);
            }).catch(error => {
                this.logger.error(error);
                reject(error);
            });
        });
    }

    private loginAll(servers: Server[]): Promise<Server[]> {
        return Promise.all(servers.map(s => this.login(s)));
    }

    public async uploadFile(uploadPath: string, fileName: string, filePath: string): Promise<any[]> {
        try {
            let servers = await this.ready;
            let requests = servers.map(server => {
                let req = request.post(`${server.host}:${server.port}/${uploadPath}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Accept': 'application/json'
                        }
                    });
                let form = req.form();
                form.append(fileName, fs.createReadStream(filePath));
                return req;
            });
            let responses = await Promise.all(requests);
            responses.forEach(r => this.logJSONResponse(r));
            return responses;
        } catch (error) {
            this.logJSONResponse(error);
        }
    }

    private getPropertiesFromNode(path: string, node: any): Property[] {
        let properties: Property[] = [];
        for (let nodeName in node) {
            if (nodeName === '$') { // attrbutes
                let attributes = node['$'];
                for (let attributeName in attributes) {
                    if (attributeName.search('xmlns') < 0) {
                        let attributeValue: string = attributes[attributeName];
                        let hasType = attributeValue.match('^{(.*)}(.*)');
                        if (hasType) { //matches to a type
                            let type = hasType[1];
                            let value = hasType[2];
                            let isArray = value.match('^\\[(.*)\\]$');
                            if (isArray) { //matches to an array
                                let values = isArray[1].split(',');
                                values.forEach(v => {
                                    properties.push({ name: `${path}/${attributeName}`, value: v });
                                });
                                properties.push({ name: `${path}/${attributeName}@TypHint`, value: `${type}[]` });
                            } else {
                                properties.push({ name: `${path}/${attributeName}`, value: value });
                                properties.push({ name: `${path}/${attributeName}@TypeHint`, value: type });
                            }
                        } else { //regular string
                            let isArray = attributeValue.match('^\\[(.*)\\]$');

                            if (isArray) { //matches to an array
                                let values = isArray[1].split(',');
                                values.forEach(v => {
                                    properties.push({ name: `${path}/${attributeName}`, value: v });
                                });
                            } else {
                                properties.push({ name: `${path}/${attributeName}`, value: attributeValue });
                            }
                        }
                    }
                }
            } else if (nodeName !== '_') { // children nodes
                let childNodes: any[] = node[nodeName];
                properties.push({ name: `${path}/${nodeName}`, value: '' });
                _.take(childNodes, 1).forEach((c: any) => { // prevent duplicated nodes, only takes the first one 
                    properties.push(...this.getPropertiesFromNode(`${path}/${nodeName}`, c));
                });
            }
        }
        return properties;
    }

    public async uploadNodes(uploadPath: string, filePath: string, currentNode: string, addDeleteAttribute?: boolean): Promise<any[]> {
        try {
            let file = await this.readFileAsync(filePath);
            let fileContent = await this.parseFileToXmlAsync(file);

            let root = fileContent['jcr:root'];
            let properties: Property[] = this.getPropertiesFromNode(`./${currentNode}`, root);

            if (addDeleteAttribute) {
                properties.unshift({ name: `./${currentNode}@Delete`, value: "delete" });
            }

            let servers = await this.ready;
            let requests = servers.map(server => {
                let req = request.post(`${server.host}:${server.port}/${uploadPath}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json'
                        },
                        body: properties.map(p => (`${p.name}=${p.value}`)).join('&')
                    });
                return req;
            });
            let response = await Promise.all(requests);

            response.forEach(r => this.logJSONResponse(r));
            return response;
        } catch (err) {
            this.logJSONResponse(err);
        }
    }

    private async howToProcessNode(normalizedFilePath: string,
        jcrPath: string, fileName: string, folderPath: string): Promise<ProcessNode | null> {
        if (fileName === ".content.xml" && _.endsWith(folderPath, "_cq_dialog")) {
            let parts = _.split(jcrPath, "/");
            let uploadPath = parts.slice(0, parts.length - 2).join("/");
            let shouldDelete = fs.readdirSync(folderPath).length < 2;
            return {
                rootNode: "cq:dialog",
                uploadPath: uploadPath,
                filePath: normalizedFilePath,
                shouldDelete: shouldDelete
            }
        }
        else if (fileName === ".content.xml") {
            let parts = _.split(jcrPath, "/");
            let uploadPath = parts.slice(0, parts.length - 2).join("/");
            let shouldDelete = fs.readdirSync(folderPath).length < 2;
            return {
                rootNode: parts[parts.length - 2],
                uploadPath: uploadPath,
                filePath: normalizedFilePath,
                shouldDelete: shouldDelete
            }
        } else if (fileName === "dialog.xml") {
            let parts = _.split(jcrPath, "/");
            let uploadPath = parts.slice(0, parts.length - 1).join("/");
            return {
                rootNode: "dialog",
                uploadPath: uploadPath,
                filePath: normalizedFilePath,
                shouldDelete: true
            }
        } else if (fileName === "_rep_policy.xml") {
            let parts = _.split(jcrPath, "/");
            let uploadPath = parts.slice(0, parts.length - 1).join("/");
            return {
                filePath: normalizedFilePath,
                uploadPath: uploadPath,
                rootNode: "rep:policy",
                shouldDelete: true
            }
        } else if (_.endsWith(fileName, ".xml")) {
            let file = await this.readFileAsync(folderPath + "/" + fileName);
            let xml = await this.parseFileToXmlAsync(file);
            let jcr_root = xml['jcr:root'];

            if (jcr_root) {
                let parts = _.split(jcrPath, "/");
                let uploadPath = parts.slice(0, parts.length - 1).join("/");
                return {
                    filePath: normalizedFilePath,
                    uploadPath: uploadPath,
                    rootNode: fileName.substring(0, fileName.lastIndexOf(".")),
                    shouldDelete: true
                }
            }
        } else {
            //upload as file
            return null;
        }
    }

    public async process(filePath: string, removeFile: boolean = false): Promise<void> {
        if (!filePath.indexOf('jcr_root')) {
            this.logger.info(`File at ${filePath} is not under jcr_root folder`);
            return;
        }

        let normalizedFilePath = _.replace(filePath, /\\/g, '/');
        let jcrPath = normalizedFilePath.substr(normalizedFilePath.lastIndexOf('jcr_root') + 'jcr_root'.length + 1);

        let lastSlashIndex = normalizedFilePath.lastIndexOf("/");
        let containingfolder = filePath.substr(0, lastSlashIndex);
        let fileName = normalizedFilePath.substr(lastSlashIndex + 1);
        let uploadPath = jcrPath.substr(0, jcrPath.lastIndexOf("/"));

        let processNode = await this.howToProcessNode(normalizedFilePath, jcrPath, fileName, containingfolder);
        if (!removeFile) {
            this.logger.info(`Modifying ${fileName}.`);
            if (processNode) {
                await this.uploadNodes(processNode.uploadPath, processNode.filePath, processNode.rootNode, processNode.shouldDelete);
            } else {
                await this.uploadFile(uploadPath, fileName, normalizedFilePath);
            }
        } else {
            this.logger.info(`Deleting ${fileName}.`);
            if (processNode) {
                await this.removeNodes(processNode.uploadPath, processNode.rootNode);
            } else {
                await this.removeFile(`${uploadPath}/${fileName}`);
            }
        }
    }

    private async removeNodes(jcrPath: string, nodeName: string): Promise<void> {
        try {
            let servers = await this.ready;
            let requests = servers.map(server => {
                let req = request.post(`${server.host}:${server.port}/${jcrPath}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json'
                        },
                        body: `./${nodeName}@Delete=true`
                    });
                return req;
            });

            let responses = await Promise.all(requests);
            responses.forEach(r => this.logJSONResponse(r));

        } catch (error) {
            this.logJSONResponse(error);
        }
    }

    public async removeFile(jcrPath: string): Promise<void> {
        try {
            let servers = await this.ready;
            let requests = servers.map(server => {
                let req = request.del(`${server.host}:${server.port}/${jcrPath}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json'
                        }
                    });
                return req;
            });

            let responses = await Promise.all(requests);
            responses.forEach(r => this.logger.info(`Deleted file : ${jcrPath}`));

        } catch (error) {
            this.logJSONResponse(error);
        }
    }

    private async readFileAsync(filename: string): Promise<Buffer> {
        return new Promise<any>((resolve, reject) => {
            fs.readFile(filename, (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(data);
                }
            });
        });
    }

    private async parseFileToXmlAsync(file: Buffer): Promise<any> {
        return new Promise<string>((resolve, reject) => {
            parseString(file, (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    }
}