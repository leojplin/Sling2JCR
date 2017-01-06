# Sling2JCR
A library that takes files and uploads its content to a configured JCR respository using Sling Post. This tool speeds up development by not having to reply on the traditional Maven install tools or by using the Brackets AEM sync plugin. This tool as convenient as using CRXDE, but without manually copy pasting code back and forth; sync to JCR without leaving your editor!

## Install
```
npm install sling2jcr --save
````

## Usage
```
sling2jcr -h [host-url] -u [username] -p [password] <directory>
```
defaults:
* host-url: http://localhost:4502
* username: admin
* password: password
