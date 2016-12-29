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
    
    private logSuccessResponse(response: any) {
        response = JSON.parse(response);
        this.logger.info(`${response['status.code']} ${response['status.message']} : ${response.title}`);
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
            responses.forEach(r => this.logSuccessResponse(r));
            return responses;
        } catch (error) {
            this.logger.error(error);
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
                            properties.push({ name: `${path}/${attributeName}`, value: attributeValue });
                        }

                    }
                }
            } else if (nodeName !== '_') { // children nodes
                let childNode = node[nodeName];
                properties.push({ name: `${path}/${nodeName}`, value: '' });
                for (let childNodeName in childNode) {
                    properties.push(...this.getPropertiesFromNode(`${path}/${nodeName}`, childNode[childNodeName]));
                }
            }
        }
        return properties;
    }

    public async uploadNodes(uploadPath: string, filePath: string, currentNode: string, addDeleteAttribute?: boolean): Promise<any[]> {
        try {
            //jcr_root\apps\cq\gui\components\authoring\componentbrowser\.content.xml
            console.log(uploadPath);
            let file = await this.readFileAsync(filePath);
            let fileContent = await this.parseFileToXmlAsync(file);

            // console.log(util.inspect(result, false, null, false));
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

            response.forEach(r => this.logSuccessResponse(r));
            return response;
        } catch (err) {
            this.logger.error(err);
        }
    }

    private howToProcessNode(normalizedFilePath: string,
        jcrPath: string, fileName: string, folderPath: string): ProcessNode | null {
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
        } else if (fileName === "dialog.xml") {
            let parts = _.split(jcrPath, "/");
            let uploadPath = parts.slice(0, parts.length - 1).join("/");
            return {
                rootNode: "dialog",
                uploadPath: uploadPath,
                filePath: normalizedFilePath,
                shouldDelete: true
            }
        } else {
            //upload as file
            return null;
        }
    }

    public process(filePath: string, removeFile: boolean = false): void {
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

        let processNode = this.howToProcessNode(normalizedFilePath, jcrPath, fileName, containingfolder);
        if (!removeFile) {
            if (processNode) {
                this.uploadNodes(processNode.uploadPath, processNode.filePath, processNode.rootNode, processNode.shouldDelete);
            } else {
                this.uploadFile(uploadPath, fileName, normalizedFilePath);
            }
        } else {
            if (processNode) {
                this.removeNodes(processNode.uploadPath, processNode.rootNode);
            } else {
                this.removeFile(`${uploadPath}/${fileName}`);
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
            responses.forEach(r => this.logSuccessResponse(r));

        } catch (error) {
            this.logger.error(error);
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
            console.log(responses);
            responses.forEach(r =>this.logger.info(`Deleted file : ${jcrPath}`));

        } catch (error) {
            this.logger.error(error);
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