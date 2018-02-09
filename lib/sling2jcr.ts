import * as Formdata from 'form-data';
import * as util from 'util';
import * as console from 'console';
import * as fs from 'fs';
import { parseString as ParseString } from 'xml2js';
import * as _ from 'lodash';
import * as Request from 'request-promise';
import * as Path from 'path';

export interface Property {
    name: string;
    value: string;

}

export interface Server {
    host: string,
    username: string,
    password: string,
    cookie?: string
}

export interface NodeStrategy {
    filePath: string,
    rootNode: string,
    uploadPath: string,
    shouldDelete: boolean
}

export class Sling2JCR {
    logger: any;

    constructor(private servers: Server[], logger?: any) {
        this.logger = logger || {
            info: console.log,
            error: console.error,
            warn: console.warn
        };
    }

    private async loginSingle(server: Server): Promise<Server> {
        return new Promise<Server>((resolve, reject) => {
            var form = `j_username=${server.username}&j_password=${server.password}&j_workspace=crx.default&j_validate=true&_charset_=utf-8`;
            Request.post({
                url: `${server.host}/crx/de/j_security_check`,
                method: 'POST',
                form: form,
                resolveWithFullResponse: true
            }).then(response => {
                let cookie = response.headers['set-cookie'][0];
                server.cookie = cookie;
                this.logger.info(`Logged in for: ${server.host}`);
                resolve(server);
            }).catch(error => {
                this.logger.error(error);
                reject(error);
            });
        });
    }

    public login(): Promise<Server[]> {
        return Promise.all(this.servers.map(s => this.loginSingle(s)));
    }

    public async process(filePath: string, removeFile: boolean = false): Promise<void> {
        if (filePath.indexOf('jcr_root') < 0) {
            this.logger.info(`File at ${filePath} is not under jcr_root folder`);
            return;
        }

        let path = Path.parse(filePath);

        let nodeStrategy = await this.getNodeStrategy(path);
        if (!removeFile) {
            this.logger.info(`Modifying ${path.name}${path.ext}.`);
            if (nodeStrategy) {
                await this.uploadNodes(nodeStrategy.uploadPath, nodeStrategy.filePath, nodeStrategy.rootNode, nodeStrategy.shouldDelete);
            } else {
                await this.uploadFile(path);
            }
        } else {
            this.logger.info(`Deleting ${path.name}${path.ext}.`);
            if (nodeStrategy) {
                await this.removeNodes(nodeStrategy.uploadPath, nodeStrategy.rootNode);
            } else {
                await this.removeFile(path);
            }
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

    private async uploadNodes(uploadPath: string, filePath: string, rootNode: string, addDeleteAttribute: boolean = false): Promise<void> {
        try {
            let file = await this.readFileAsync(filePath);
            let fileContent = await this.parseFileToXmlAsync(file);

            let root = fileContent['jcr:root'];
            let properties: Property[] = this.getPropertiesFromNode(`./${rootNode}`, root);

            if (addDeleteAttribute) {
                properties.unshift({ name: `./${rootNode}@Delete`, value: "delete" });
            }

            let requests = this.servers.map(server => {
                let req = Request.post(`${server.host}/${uploadPath}`,
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
        } catch (err) {
            this.logJSONResponse(err);
        }
    }

    private async getNodeStrategy(path: Path.ParsedPath): Promise<NodeStrategy | null> {
        let fileName = `${path.name}${path.ext}`;
        let filePath = `${path.dir}${Path.sep}${path.base}`;
        let jcrPath = path.dir.substr(path.dir.lastIndexOf('jcr_root') + 'jcr_root'.length + 1);
        let pathSegements = _.split(jcrPath, Path.sep);
        
        if (fileName === ".content.xml" && _.endsWith(path.dir, "_cq_dialog")) {
            let shouldDelete = fs.readdirSync(path.dir).length < 2;
            let uploadPath = pathSegements.slice(0, pathSegements.length - 1).join("/");
            return {
                rootNode: "cq:dialog",
                uploadPath: uploadPath,
                filePath: filePath,
                shouldDelete: shouldDelete
            }
        }
        else if (fileName === ".content.xml") {
            let uploadPath = pathSegements.slice(0, pathSegements.length - 1).join("/");
            let shouldDelete = fs.readdirSync(path.dir).length < 2;
            return {
                rootNode: pathSegements[pathSegements.length - 1],
                uploadPath: uploadPath,
                filePath: filePath,
                shouldDelete: shouldDelete
            }
        } else if (fileName === "_rep_policy.xml") {
            let uploadPath = pathSegements.slice(0, pathSegements.length).join("/");
            return {
                filePath: filePath,
                uploadPath: uploadPath,
                rootNode: "rep:policy",
                shouldDelete: true
            }
        } else if (_.endsWith(fileName, ".xml")) {
            let uploadPath = pathSegements.slice(0, pathSegements.length).join("/");
            let file = await this.readFileAsync(filePath);
            let xml = await this.parseFileToXmlAsync(file);
            let jcr_root = xml['jcr:root'];
            if (jcr_root) {
                return {
                    filePath: filePath,
                    uploadPath: uploadPath,
                    rootNode: fileName.substring(0, fileName.lastIndexOf(".")),
                    shouldDelete: true
                }
            }
        }
        return null;
    }

    private async uploadFile(path: Path.ParsedPath) {
        try {
            let uploadPath = path.dir.substr(path.dir.lastIndexOf('jcr_root') + 'jcr_root'.length + 1);
            
            let requests = this.servers.map(server => {
                let req = Request.post(`${server.host}/${uploadPath}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Accept': 'application/json'
                        }
                    });
                let form = req.form();
                form.append(`${path.name}${path.ext}`, fs.createReadStream(`${path.dir}${Path.sep}${path.base}`));
                return req;
            });
            let responses = await Promise.all(requests);
            responses.forEach(r => this.logJSONResponse(r));
        } catch (error) {
            this.logJSONResponse(error);
        }
    }

    private async removeNodes(jcrPath: string, nodeName: string): Promise<void> {
        try {
            let requests = this.servers.map(server =>
                Request.post(`${server.host}/${jcrPath}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json'
                        },
                        body: `./${nodeName}@Delete=true`
                    })
            );
            let responses = await Promise.all(requests);
            responses.forEach(r => this.logJSONResponse(r));
        } catch (error) {
            this.logJSONResponse(error);
        }
    }

    public async removeFile(path: Path.ParsedPath): Promise<void> {
        try {
            let jcrPath = path.dir.substr(path.dir.lastIndexOf('jcr_root') + 'jcr_root'.length + 1);
            
            let requests = this.servers.map(server =>
                Request.del(`${server.host}/${jcrPath}/${path.base}`,
                    {
                        headers: {
                            'Cookie': server.cookie,
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json'
                        }
                    })
            );
            let responses = await Promise.all(requests);
            responses.forEach(r => this.logger.info(`Deleted file : ${jcrPath}/${path.base}`));
        } catch (error) {
            this.logJSONResponse(error);
        }
    }

    private logJSONResponse(response: any) {
        try {
            if (typeof response === "string") {
                response = JSON.parse(response);
            } else if (typeof response === "object") {
                response = JSON.parse(response.error)
            }
            this.logger.info(`${response['status.code']} ${response['status.message']} : ${response.title}`);
        } catch (error) {
            this.logger.error(response);
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
            ParseString(file, (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    }
}