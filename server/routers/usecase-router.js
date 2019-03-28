// This is a sample usecase router. This is where you add your usecase logic.

// You do not need to explicitly initialize express application, this is done in auto-generated server.js file
var express = require('express');

// Use serviceManager to get all the initialized service SDKs
var serviceManager = require('../services/service-manager');

module.exports = function(app) {
    // The app argument in this function is the express application.
    // You can add middlewares, routers or any other components you require as shown below.
    var router = express.Router();

    // Use serviceManager to get SDK for a particular service
    var serviceSDK = serviceManager.get('service-name');

    // Add usecase logic endpoints to the express app

    app.use('/usecase', router);
};
