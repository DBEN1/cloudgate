var fs = require('fs');
const memory = require('../modules/memory');
const staticFiles = require('../modules/static-files');
const apiFunctions = require('../modules/api-functions.js');
const websocketFunctions = require('../modules/websocket-functions.js');
const cloudgateWebsocket = require('../modules/cloudgate-websocket.js');
const cloudgateAPI = require('../modules/cloudgate-api.js');
const apiDB = require('../modules/api-db.js');
const tools = require('../lib/tools.js');

//In-memory cache
var cache = {};
var _serverConfig = null;

module.exports = {
    start: (app, serverConfig) => {
        var modules = [apiFunctions, apiDB, staticFiles];

        if ( _serverConfig == null ){
            _serverConfig = serverConfig;
        }

        memory.set("StartTime", (+new Date()), "STATS")

        //REST
        app.any('/*', async (res, req) => {

            //Ensure this request is notified on aborted
            res.onAborted(() => {
                res.aborted = true;
            });

            //185K RPS per core - best perf possible
            //res.end("Hello World");
            //return;

            //test raw performance without any processing pipeline
            var tmpUrl = req.getUrl();
            if ( tmpUrl == "/cloudgate/debug/raw") {
                res.end("Hello World!");
                return;
            }

            //UPDATE STATS
            memory.incr("http.requests", 1, "STATS");
            //console.log("New request on a node");

            try {
                var host = req.getHeader('host');
                var subDomain = host.split('.')[0];
                var domain = host.substring(host.indexOf('.') + 1).split(':')[0];
                var reqInfos = {
                    url: req.getUrl(),
                    host: host,
                    query: req.getQuery(),
                    method: req.getMethod(),
                    ip: tools.getIP(req, res),
                    headers: {},
                    req: req,
                }

                //handle cloudgate commands (control + replication)
                if ( serverConfig && serverConfig.adminEnabled == "1" ){
                    if ( reqInfos.url == serverConfig.adminpath){
                        
                        var result = await cloudgateAPI.process(reqInfos, res, req, memory, serverConfig);

                        res.writeStatus("" + (result.status || 200));
                        for (var key in result.headers) {
                            res.writeHeader(key, result.headers[key]);
                        }

                        if (result.content != null) {
                            if (typeof result.content === 'object') {
                                //res.write(JSON.stringify(processResult.content));
                                res.write(result.content);
                            }
                            else {
                                res.write(result.content);
                            }
                        }

                        tools.debugLog("CloudGateAPI", (result.status || 200), result.content.length, reqInfos, serverConfig);

                        res.end();
                        return;
                    }
                }


                var appConfig = memory.getObject(subDomain + "." + domain, "GLOBAL");
                
                //handle *
                if (appConfig == null) {
                    appConfig = memory.getObject("*", "GLOBAL"); //avoid constant call to redis
                }

                //handle *.XXXXX.xxx
                if (appConfig == null) {
                    appConfig = memory.getObject("*." + domain, "GLOBAL"); //avoid constant call to redis
                }
                
                if (typeof (appConfig) == 'undefined' || appConfig == null) {

                    tools.debugLog("GLOBAL", 404, result.content.length, reqInfos, serverConfig);
                    
                    res.writeStatus("404");
                    res.writeHeader("target", subDomain + "." + domain);
                    res.end("No app configured for vhost [" + subDomain + "." + domain + "]");
                    return;
                }

             
                //force main domain & SSL
                /*
                if ( appConfig.mainDomain != null && appConfig.mainDomain != "" && appConfig.mainDomain != subDomain + "." + domain ){
                //should redirect to maindomain 
                console.log("redirect to: " + appConfig.mainDomain);    
                res.writeStatus("301");
    
                var protocol = "http://";
                if ( appConfig.forceSSL == true ){
                    protocol = "https://";
                }
                res.writeHeader("location", protocol + appConfig.mainDomain + reqInfos.url + reqInfos.query);
    
                res.end("No app configured for vhost [" + subDomain + "." + domain + "]");
                return ;
                }
                */

                //Caching: think about caching of GET only!
                var cacheKey = null;
                if (reqInfos.method == "get") {
                    cacheKey = host + reqInfos.url + reqInfos.query;
                }
        
                //console.log(memory.debug());
                var cacheContent = memory.get(cacheKey, "ResponseCache");
                if (cacheContent != null) {

                    if ( serverConfig.debug){
                        console.log("Serving from cache:" + cacheKey)  ;
                    }

                    //console.log("cachefound for: " + cacheKey + " - " + host)
                    var totalBytesSent = 0;

                    var processResult = cacheContent;
                    res.writeStatus("" + (processResult.status || 200));
                    for (var key in processResult.headers) {
                        res.writeHeader(key, processResult.headers[key]);
                        totalBytesSent += key.length + processResult.headers[key].length;
                    }

                    if (processResult.content != null) {
                        
                        if ( processResult.content.length != null ){
                            totalBytesSent += processResult.content.length;
                            //console.log("content: " + totalBytesSent);
                        }
                        
                        res.end(processResult.content);
                    }

                    if ( totalBytesSent != null ){
                        //console.log("Adding: " + totalBytesSent);
                        memory.incr("http.data.out", totalBytesSent, "STATS");
                    }

                    tools.debugLog("HTTP", (processResult.status || 200), totalBytesSent, reqInfos, serverConfig);
                    
                    return;
                }


                //var beginPipeline = process.hrtime();

                var hasBeenProcessed = false;
                var processResult = null;
                for (var i = 0; i < modules.length; i++) {

                    //var begin = process.hrtime();
                    var module = modules[i];
                    var result = await module.process(appConfig, reqInfos, res, req, memory, serverConfig);
                    //const nanoSeconds = process.hrtime(begin).reduce((sec, nano) => sec * 1e9 + nano);
                    //console.log("Module: " + i + " - " + (nanoSeconds/1000000) + "ms");

                    if (result && result.processed) {
                        
                        hasBeenProcessed = true;
                        processResult = result;

                        //keep in cache only static files response
                        if (modules[i].name == "static-files") {

                            //keep in cache only if no error
                            if ( processResult.error == null || processResult.error.trim() == "" )
                            {
                                //console.log("cache written for " + reqInfos.url);
                                memory.set(cacheKey, processResult, "ResponseCache");
                            }
                            else{
                                //console.log( "test: " + processResult.error);
                            }
                        }
                        break;
                    }
                }

                //const nanoSecondsPipeline = process.hrtime(beginPipeline).reduce((sec, nano) => sec * 1e9 + nano);
                //console.log("processing Pipeline: " + (nanoSecondsPipeline/1000000) + "ms");

                if (!res.aborted) {
                    if (!hasBeenProcessed) {
                        processResult = {
                            status: 404,
                            headers: {
                                "cache-control": "public, max-age=30",
                                "expires": new Date(Date.now() + 30 * 1000).toUTCString(),
                                "last-modified": new Date(Date.now()).toUTCString(),
                                "content-type": "text/html;charset=utf-8;",
                            }
                        }
                        var path404 = tools.safeJoinPath(__dirname, '..', './default/404.html')
                        // TODO : handle path to 404 in the config file
                        //404
                        var content404 = "";
                        var cache404Key = appConfig.root + "_" + path404;
                        var cache404 = memory.get(cache404Key, "ResponseCache");
                        if (cache404 != null) {
                            processResult.headers['core-cache'] = '1';
                            processResult.headers['Content-Encoding'] = 'gzip';
                            processResult.content = cache404;
                        }
                        else {
                            content404 = fs.readFileSync(path404, { encoding: 'utf8' });
                            processResult.headers['Content-Encoding'] = 'gzip';
                            processResult.content = tools.GzipContent(content404);
                            memory.set(cache404Key, processResult.content, "ResponseCache");
                        }
                    }

                    var totalBytesSent = 0;

                    // FINAL WRITING
                    res.writeStatus("" + (processResult.status || 200));
                    for (var key in processResult.headers) {
                        res.writeHeader(key, processResult.headers[key]);
                        totalBytesSent += key.length + processResult.headers[key].length;
                    }

                    if (processResult.content != null) {
                        if (typeof processResult.content === 'object') {
                            res.write(processResult.content);
                        }
                        else {
                            res.write(processResult.content);
                        }
                        totalBytesSent += processResult.content.length;
                    }
                    res.end();

                    memory.incr("http.data.out", totalBytesSent, "STATS");
                    tools.debugLog("HTTP", (processResult.status || 200), totalBytesSent, reqInfos, serverConfig);

                }
                return;
            }
            catch (ex) {

                //console.log(ex);
                var erroMSG = ex + ""; //force a cast to string
                if (erroMSG.indexOf("Invalid access of discarded") == -1) {
                    console.log("Error11819: ");
                    console.log(ex);
                    res.end("404 NOT FOUND"); //but in fact an error occured ...
                }

            }

        })

        //WEBSOCKET
        app.ws('/*', {

            /* Options */
            compression: 0,
            maxPayloadLength: 16 * 1024 * 1024,
            idleTimeout: 60*60*24*1, //1 day

            /* Handlers */
            open: async (ws, req) => {
                //Code to execute each time a new websocket is established (eg: authentication, count connected users, ...)

                //UPDATE STATS
                memory.incr("websocket.connected", 1, "STATS");
                memory.incr("websocket.requests", 1, "STATS");

                var host = req.getHeader('host');
                var subDomain = host.split('.')[0];
                var domain = host.substring(host.indexOf('.') + 1).split(':')[0];
                var reqInfos = {
                    host: host,
                    subDomain: subDomain,
                    domain: domain,
                    url: req.getUrl(),
                    query: req.getQuery(),
                    method: req.getMethod(),
                    ip: tools.getIP(req, ws),
                    headers: {},
                }

                reqInfos.app = app;

                req.forEach((k, v) => {
                    reqInfos.headers[k] = v;
                });
                ws.reqInfos = reqInfos;
                ws.req = req;

                var appConfig = memory.getObject(subDomain + "." + domain, "GLOBAL");
                //handle *
                if (appConfig == null) {
                    appConfig = memory.getObject("*", "GLOBAL");
                }

                //handle *.XXXXX.xxx
                if (appConfig == null) {
                    appConfig = memory.getObject("*." + domain, "GLOBAL"); //avoid constant call to redis
                }

                //console.log("websocket appconfig: " + JSON.stringify(appConfig));

                if (typeof (appConfig) == 'undefined' || appConfig == null) {
                    tools.debugLog("WS", 404, 0, ws.reqInfos, serverConfig);
                    ws.send(`{"error": "No app configured", "vhost": "${subDomain + "." + domain}"}`, false, false);
                    ws.close();
                }

                ws.appConfig = appConfig;

                //handle cloudgate commands (control + replication)
                
                if ( _serverConfig && _serverConfig.adminEnabled == "1" ){
                    
                    if ( reqInfos.url == _serverConfig.adminpath){
                        
                        var result = await cloudgateWebsocket.open(appConfig, reqInfos, ws, req, memory);
                        if ( result.content != null ){
                            tools.debugLog("CloudGateWS", (result.status || 200), result.content.length, reqInfos, serverConfig);
                            ws.send(result.content, false, false);
                        }
                        return;
                    }
                }

                //handle normal apps
                var result = await websocketFunctions.open(appConfig, reqInfos, ws, req, memory);
                if ( result.content != null ){
                    tools.debugLog("WS", (result.status || 200), result.content.length, reqInfos, serverConfig);
                    ws.send(result.content, false, false);
                }
                

            },
            message: async (ws, message, isBinary) => {

                //UPDATE STATS
                memory.incr("websocket.requests", 1, "STATS");
                memory.incr("websocket.data.in", message.byteLength, "STATS");

                try{
                    
                    //handle cloudgate commands (control + replication)
                    if ( _serverConfig && _serverConfig.adminEnabled == "1" ){
                        if ( ws.reqInfos.url == _serverConfig.adminpath){
                            var result = await cloudgateWebsocket.message(ws.appConfig, ws.reqInfos, ws, null, memory, message, isBinary);
                            //response is done directly in cloudgateWebSocket (because it can respond multiple things)
                            return;
                        }
                    }

                    //handle normal apps
                    var result = await websocketFunctions.message(ws.appConfig, ws.reqInfos, ws, null, memory, message, isBinary);
                    if ( result.content != null ){

                        memory.incr("websocket.data.out", result.content.length, "STATS");
                        ws.send(result.content, false, false);

                        tools.debugLog("WS", (result.status || 200), result.content.length, reqInfos, serverConfig);
                    }
                }
                catch(ex){
                    console.log("Error while executing a websocket function: " + ex.message);
                    console.log(ex);
                }
 
            },
            drain: (ws) => {
                console.log("Warning: Router DRAIN! We should slow down");
            },
            close: async (ws, code, message) => {
                /* The library guarantees proper unsubscription at close */
                //redis.incrby("/counter/users", -1);

                //UPDATE STATS
                memory.incr("websocket.connected", -1, "STATS");

                try{

                    //handle cloudgate commands (control + replication)
                    if ( _serverConfig && _serverConfig.adminEnabled == "1" ){
                        if ( ws.reqInfos.url == _serverConfig.adminpath){
                            var result = await cloudgateWebsocket.close(ws.appConfig, ws.reqInfos, ws, null, memory, message, false);
                            return;
                        }
                    }

                    //handle normal apps
                    var result = await websocketFunctions.message(ws.appConfig, ws.reqInfos, ws, null, memory);
                }
                catch(ex){
                    console.log(ex);
                }

            }
        })

    }
}