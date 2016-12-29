# Sling2JCR
A library that takes files and uploads its content to a configured JCR respository using Sling Post. This tool speeds up development by not having to reply on the traditional Maven install tools or by using the Brackets AEM sync plugin. This tool as convenient as using CRXDE, but without manually copy pasting code back and forth; sync to JCR without leaving your editor!

## Install
```
npm install sling2jcr --save
````

## Usage
```javascript
"use strict";
var sling2jcr = require("sling2jcr");
var fs = require("fs");
var watch = require('node-watch');

//servers is an array to all the servers you want to sync to, a sample author server is shown.
var config = {
  "jcr_root" : "absolute path to the jcr_root folder or any sub directory of it.",
  "servers": [{
    "host": "http://localhost",
    "port": 4502,
    "username": "admin",
    "password": "admin"
  }]
};

//create a new instance
var lib = new sling2jcr.Sling2JCR(config.servers);

//watch the files under the jcr_root folder, or any sub directory under it. Files not under a sub directory of jcr_root won't be synchronized.
watch(config.jcr_root, function (filePath) {
    if (fs.existsSync(filePath)) { // Since "deleted" event is also emitted as a "change" event due to API limitation, check if the file exist first. 
        if (fs.statSync(filePath).isFile()) { // Te directory of the changed file is also emitted as an event, check for the file only.
            lib.process(filePath);
        }
    }
    else { // File does not exist, delete from repository. Pass true as the second argument to the process method to indicate deletion of the file.
        lib.process(filePath, true);
    }
});
```
