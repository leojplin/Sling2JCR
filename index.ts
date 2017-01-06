#! /usr/bin/env node

import { Sling2JCR } from "./lib/sling2jcr";
import * as fs from "fs";
import * as commander from 'commander';
import * as watch from 'node-watch';


commander
    .version('1.0.1')
    .arguments('<directory>')
    .option('-h, --host [host]', 'Fully qualified URL for the host, port should be included if it is not 80. (default to "http://localhost:4502")')
    .option('-u, --username [username]', 'Username that used to login to the server. (default to "admin")')
    .option('-p, --password [password]', 'Password that used to login to the server. (default to "admin")')
    .action(dir => {
        startUp(dir);
    });

commander.parse(process.argv); // end with parse to parse through the input

function startUp(dir: string) {
    let config = {
        jcr_root: dir,
        servers: [{
            host: commander.host || "http://localhost:4502",
            username: commander.username || "admin",
            password: commander.password || "admin"
        }]
    };

    //create a new instance
    let sling2JCR = new Sling2JCR(config.servers);
    sling2JCR.login().then(servers => {
        //watch the files under the jcr_root folder, or any sub directory under it. Files not under a sub directory of jcr_root won't be synchronized.
        watch(config.jcr_root, filePath => {
            if (fs.existsSync(filePath)) { // Since "deleted" event is also emitted as a "change" event due to API limitation, check if the file exist first. 
                if (fs.statSync(filePath).isFile()) { // Te directory of the changed file is also emitted as an event, check for the file only.
                    sling2JCR.process(filePath);
                }
            }
            else { // File does not exist, delete from repository. Pass true as the second argument to the process method to indicate deletion of the file.
                sling2JCR.process(filePath, true);
            }
        });
    }).catch(error => {
        console.log(error);
    });
}
