/* 

Scraper script searching store for apps and archiving app data said apps.

NOTE: 120 is max number of apps to receive at once through list method...
NOTE: this has a permission section could inspect when throw this into folder
NOTE: cronjob...

TODO: to avoid the situation of askign for a captcha use a throttle keyword
, all methods now support a throttle property, which defines an upper bound to 
the amount of requests that will be attempted per second. Once that limit is reached, 
further requests will be held  until the second passes.

*/
var config = require("/etc/xray/config.json"); //See example_config.json
var gplay = require("google-play-scraper");
var _ = require("lodash");
var path = require('path');
//Reading from folder of csv files
var fs = require('fs');
var fs_promise = require('fs-readdir-promise');
var readline = require('readline');

//Logging mechanisim for script
const EMERG = 0,
    ALERT = 1,
    CRIT = 2,
    ERR = 3,
    WARN = 4,
    NOTICE = 5,
    INFO = 6,
    DEBUG = 7;

var prefixes = ['<0>', '<1>', '<2>', '<3>', '<4>', '<5>', '<6>', '<7>'];

var logger = {
    //console.log(prefixes[INFO], txt);
    info: function(txt) {
        console.log(prefixes[INFO], txt);
    },
    err: function(txt) {
        console.log(prefixes[ERR], txt);
    },
    alert: function(txt) {
        console.log(prefixes[ALERT], txt);
    },
    crit: function(txt) {
        console.log(prefixes[CRIT], txt);
    },
    warn: function(txt) {
        console.log(prefixes[WARN], txt);
    },
    notice: function(txt) {
        console.log(prefixes[NOTICE], txt);
    },
    debug: function(txt) {
        console.log(prefixes[DEBUG], txt);
    }
}
logger.info("Logger initialised");




//Generate sub apps folders
var fs = require("fs");

var appsSaveDir = require('path').join(config.datadir, "apps");

if (!require('fs').existsSync(appsSaveDir)) {
    logger.info("New apps folder needed "+ appsSaveDir);
    require("shelljs").mkdir("-p", appsSaveDir);
}


//TODO: move region to config or section to iterate over
var region = "us";
var appStore = "play";


function resolveAPKDir(appData) {

    let path = require("path");
    //console.log("appdir:"+ config.datadir, "\nappId"+ appData.appId, "\nappStore"+ appStore, "\nregion"+ region, "\nversion"+ appData.version);
    //log("appdir:"+ config.appdir, "\nappId"+ appData.appId, "\nappStore"+ appStore, "\nregion"+ region, "\nversion"+ appData.version);
    //NOTE: If app version is undefined setting to  date
    if (!appData.version || appData.version === "Varies with device") {
        logger.debug("Version not found defaulting too",appData.updated);
        let formatDate =  appData.updated.replace(/\s+/g, '').replace(',','/');
        appData.version = formatDate;
    }

    let appSavePath = path.join(appsSaveDir, appData.appId, appStore, region, appData.version);
    logger.info("App desired save dir "+ appSavePath);

    /* check that the dir created from config exists. */
    const fsEx = require('fs-extra');

    return fsEx.pathExists(appSavePath).then(exists => {
        logger.info("Does app save exist already? : "+ exists);
        if (exists) {
            logger.debug("App version already exists"+ appSavePath);
            return Promise.reject(appData.appId);
        } else {
            logger.info("New app version "+ appSavePath);
            require("shelljs").mkdir("-p", appSavePath);
            return appSavePath;
        }
    }).catch(function(err) {
        logger.err('Could not create a app save dir ', err);
        return Promise.reject(appData.appId);
    });
}


function spawnGplayDownloader(args) {

    const spw = require('child-process-promise').spawn;
     logger.info("Passing args to downloader" +args);
    const apkDownloader = spw("gplaycli", args);    

    var downloadProcess = apkDownloader.childProcess;

    logger.info('APK downloader created childProcess.pid: '+ downloadProcess.pid);

    downloadProcess.stdout.on("data", data => {
        logger.info(`The downloader process produce the following stdout: ${data}`);
    });

    downloadProcess.stderr.on("data", data => {
        logger.warn(`The downloader process produce the following stderr: ${data}`);
    });

    return apkDownloader;
}


//TODO: check dir setup before attempting to search on that word

function extractAppData(appData) {
    //Check appData state
    if (!appData.appId) { return Promise.reject("Invalid appdata", appData.appId); }

    var resolveApk = resolveAPKDir(appData);
    //log("Resolve apk",resolveApk).then(() => { resolve(); }, (err) => { log("last dl failed:", err); });

    resolveApk.then(appSaveDir => {

        let args = ["-pd", appData.appId, "-f", appSaveDir, "-c", config.credDownload]; /* Command line args for gplay cli */

        logger.info("Python downloader playstore starting");
       
       
        let spawnGplay = spawnGplayDownloader(args);
        //log("Gplay spwaner",spawnGplay);

        spawnGplay.then(pipeCode => {

            logger.info("Download process complete for "+ appData.appId);

            // TODO: DB Comms... this can be factorised.
            var db = require('./db');
            var dbId = db.insertPlayApp(appData, region);

            dbId.then(() => {
                var unix = require('unix-dgram');
                var client = unix.createSocket('unix_dgram');

                // TODO: if unix fails keep trying the socket
                if (require('fs').existsSync(config.sockpath)) {
                    logger.err('Could not bind to socket... try again later  ', err.message);
                    return Promise.reject(appData.appId);
                }

                // TODO: Check that '-' won't mess things up on the DB side... eg if region was something like 'en-gb'
                var message = Buffer(dbId + "-" + appData.appId + "-" + config.appStore + "-" + region + "-" + appData.version);

                client.on('error', logger.err);
                client.send(message, 0, message.length, config.sockpath);

                client.close(); /* The end of one single app download and added to the DB */

            }).catch(function(err) {

                logger.err('Could not write to db ', err.message);
                return Promise.reject(appData.appId);
            });
        }).catch(function(err) {
            logger.warn('Downloading failed with error: ', err.message);

            return Promise.reject(appData.appId);
        });
    }).catch(function(err) {
        logger.err('Could not save apps ', err.message);
        return Promise.reject(appData.appId);
    });
}

//Base scrapes array apps based on google-play-scraper app json format - PROMISE FORMAT
function scrape(appsData) {
    return appsData.map((val) => {
        return gplay.app({ appId: val.appId }).then(function(some_other_val) {
            return extractAppData(val).then(() => {
                logger('finished downloading', val.appId);
                return val; // whatever you return here will get passed on to the next val in the promise chain..
            }).catch((e) => {
                logger.err('error downloading ', val.appId, e.toString());
                throw e;
            });
        }).catch(function(err) {
            logger.err('Could not save app ', err);
            return Promise.reject(appData.appId);
        });
    });
}


/* Get an array of gplay Search results */
function scrapeWord(word) {
    return gplay.search({
        term: word,
        num: 4,
        region: region,
        price: 'free',
        fullDetail: true,
        throttle: 0.01,
    });
}

var wordStash = config.wordStashDir;


function reader(filepath) {
    return readline.createInterface({
        input: fs.createReadStream(filepath)
    });
}


//Do processing syncrounously do prevent gplay having a moan
function processAppData(appsData, processFn) {
    var index = 0;
    function next() {
        if (index < appsData.length) {
            logger.logger("Processing ", index);
            processFn(appsData[index++])
                .then(next)
                .catch((err) => { logger.warn("downloading app failure:", err) });
        }
    }
    next();
}

function wipe_scraped_word() {
    fs.writeFile(config.datadir + '/scraped_words.txt', '', function(err) {
        if (err) {
            logger.err('Unable wipe the scraped word file');
        }
    })
}

function write_latest_word(word) {
    fs.appendFile(config.datadir + '/scraped_words.txt', word + '\n', function(err) {
        if (err) {
            logger.err('Unable to log to the scraped word file');
        }
    })
}

// function topApps() {
//     gplay.category.forEach( cat => {
//         gplay.collection.forEach( coll => {
//             //TODO: this might all happen at once... review owrdStashFiles
//             //finish below off then scrape data + download
//             gplay.list({
//                 collection
//                 category
//                 num: 12,
//                 region: region,
//                 fullDetail: true,
//                 throttle: 0.01
//             }).then( app => {

//                 //TODO: later before begin scraping you do a similar search here

//                 return extractAppData(app);  
//             }).catch( err => {
//                 log("Err with word stash",err.message);
//             });

//         });
//     });
// }

wipe_scraped_word();
var wordStashFiles = fs_promise(wordStash);

wordStashFiles.then(files => {
    var q = Promise.resolve();

    files.map(file => {
        q = q.then(() => {
            return new Promise((resolve, reject) => {
                logger.info("Resolving word stash"+ wordStash);
                var filepath = require("path").join(wordStash, file);

                var rd = reader(filepath);

                var p = Promise.resolve();

                rd.on('line', (word) => {
                    p = p.then(() => {
                        logger.info("searching on word:"+ word);
                        write_latest_word(word);
                        return scrapeWord(word).then(function(appsData) {

                            logger.info("Search apps total: "+ appsData.length);

                            logger.info("Search apps total: "+ appsData.length);

                            var r = Promise.resolve();

                            appsData.forEach(app => {

                                r = r.then(() => {
                                    logger.info("Attempting to download:"+ app.appId);
                                    return extractAppData(app);
                                }, (err) => { logger.warn("downloading app failed:"+ err) });
                            });
                            //processAppData(appsData,extractAppData);

                        }, (err) => { logger.err("scraping app on word failed:"+ err) });
                    }), (err) => { logger.err("going through word list failed:"+ err) };
                });

                rd.on('end', () => {
                    p.then(() => { resolve(); }, (err) => { logger.err("last data word failed:"+ err); });
                });
            });
        }, (err) => { logger.err("could no iterate through words in file:"+ err); });
    }, (err) => { logger.err("iterating through dir word list failed::"+ err); });
}).catch(function(err) {
    logger.err("Err with word stash"+ err.message);
});




//var parse = require('csv-parse');
//var async = require('async');
//TODO: Promise that you'll change this to promises.
/* parse 'Top Words' and download apps based on the search results. */
// NOTE: word csv's are not comma seperated, actually '\n'...
// var parser = parse({ delimiter: ',' }, function(err, data) {
//     async.eachSeries(data, function(currWord, callback) {
//         scrapeWord(currWord).then(appsScraped => {

//             appsScraped.map(app => {
//                 log("Downloading app: "+ app.appId);
//                 downloadAppApk(app);
//             });

//             // when processing finishes invoke the callback to move to the next one
//             callback();
//         });
//     })
// });

// // Loop through all the files in the word stash
// fs.readdir(wordStash, function(err, files) {
//     if (err) {
//         logger.err("Could not list the directory."+ err);
//         process.exit(1);
//     }

//     files.forEach(file => {
//         var p = require("path");
//         fs.createReadStream(p.join(wordStash,file)).pipe(parser);
//     });
// });