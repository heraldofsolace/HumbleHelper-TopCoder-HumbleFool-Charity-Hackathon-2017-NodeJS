# IMPORTANT

Do not try to run locally as it will not work (requires IBM cloud account. So if you have one, go ahead. I have forgotten where to change the credentials so you are on your own)

This was written by me as a complete noob in Node. I rolled a dice and picked Node and learned along as i wrote this code. So there are places where you'll see code that will make your eyes bleed (don't look at the code that searches for an user, please). So, don't judge me.  I work as a Node JS developer now, and I have improved.

## What is this and how does this work?

Read this [Story on medium](https://codeburst.io/my-experience-participating-in-the-humblefool-charity-hackathon-2017-3541cdf078ae)

# HumbleHelper
A generated Bluemix application

[![](https://img.shields.io/badge/bluemix-powered-blue.svg)](https://bluemix.net)

## Run locally as Node.js application

```bash
npm install
npm test
npm start
```

## Build, run, and deploy using IDT

```bash
# Install needed dependencies:
npm run idt:install
# Build the docker image for your app:
npm run idt:build
# Run the app locally through docker:
npm run idt:run
# Deploy your app to IBM Cloud:
npm run idt:deploy
```
