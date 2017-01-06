#! /usr/bin/env node
"use strict";
var sling2jcr_1 = require("./lib/sling2jcr");
var fs = require("fs");
var commander = require("commander");
var watch = require("node-watch");
commander
    .version('1.0.1')
    .arguments('<directory>')
    .option('-h, --host [host]', 'Fully qualified URL for the host, port should be included if it is not 80. (default to "http://localhost:4502")')
    .option('-u, --username [username]', 'Username that used to login to the server. (default to "admin")')
    .option('-p, --password [password]', 'Password that used to login to the server. (default to "admin")')
    .action(function (dir) {
    startUp(dir);
});
commander.parse(process.argv); // end with parse to parse through the input
function startUp(dir) {
    var config = {
        jcr_root: dir,
        servers: [{
                host: commander.host || "http://localhost:4502",
                username: commander.username || "admin",
                password: commander.password || "admin"
            }]
    };
    //create a new instance
    var sling2JCR = new sling2jcr_1.Sling2JCR(config.servers);
    sling2JCR.login().then(function (servers) {
        //watch the files under the jcr_root folder, or any sub directory under it. Files not under a sub directory of jcr_root won't be synchronized.
        watch(config.jcr_root, function (filePath) {
            if (fs.existsSync(filePath)) {
                if (fs.statSync(filePath).isFile()) {
                    sling2JCR.process(filePath);
                }
            }
            else {
                sling2JCR.process(filePath, true);
            }
        });
    }).catch(function (error) {
        console.log(error);
    });
}
//# sourceMappingURL=index.js.map