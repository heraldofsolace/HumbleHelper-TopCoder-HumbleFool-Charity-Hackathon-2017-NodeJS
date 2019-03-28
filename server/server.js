const appName = require('./../package').name;
const express = require('express');
const log4js = require('log4js');
const localConfig = require('./config/local.json');
const passport = require('passport');
const WebAppStrategy = require('bluemix-appid').WebAppStrategy;
const userAttributeManager = require('bluemix-appid').UserAttributeManager;
const session = require('express-session');
const CloudantStore = require('connect-cloudant-store')(session);
const path = require('path');
const helmet = require('helmet');
const logger = log4js.getLogger(appName);
const port = process.env.PORT || localConfig.port;
const favicon = require('serve-favicon');
const compression = require('compression');
const debug_development = require('debug')('development');
logger.level = 'info';

const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const Cloudant = require('cloudant');
const bodyparser = require('body-parser');
const expressLogging = require('express-logging');

require('./services/index')(app);
require('./routers/index')(app);

app.use(helmet());

const LANDING_PAGE_URL = '/';
const LOGIN_URL = '/login';
const CALLBACK_URL = '/callback';
const LOGOUT_URL = '/logout';
const connections = {};
const reward_for_answer = 10;

debug_development('Running in development');
function getLevel(stars) {
    if (stars >= 10000) {
        return 'Expert';
    }

    if (stars >= 5000) {
        return 'Advanced';
    }

    if (stars >= 2000) {
        return 'Amateur';
    }
    return 'Beginner';
}

app.enable('trust proxy');
app.use(compression());

/*
    Redirect to https
 */
app.use(function(req, res, next) {
    if (req.secure || process.env.BLUEMIX_REGION === undefined) {
        next();
    } else {
        logger.info('redirecting to https');
        res.redirect('https://' + req.headers.host + req.url);
    }
});
/*
    CloudantStore for storing sessions
 */
const store = new CloudantStore(
    {
        instanceName: 'Cloudant NoSQL DB-a7',
        vcapServices: JSON.parse(process.env.VCAP_SERVICES),
        database: 'sessions',
        disableTTLRefresh: true
    }
);
app.use(expressLogging(logger));

store.on('connect', function() {
    // set cleanup job every other hour
    setInterval(function() { store.cleanupExpired(); }, 3600 * 1000);
});

store.on('disconnect', function() {
    debug_development('Can\'t connect to cloudant session store');
});

store.on('error', function(err) {
    debug_development(err);
    debug_development('Error from Cloudant: ' + err);
});
app.use(favicon(path.join(__dirname, '../build/images/favicons', 'favicon.ico')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../build/html'));
app.use(express.static(path.join(__dirname, '../build/html')));
app.use('/images', express.static(path.join(__dirname, '../build/images')));

app.use(session({
    name: 'JSESSIONID',
    secret: process.env.HUMBLEHELPER_SECRET,
    resave: false,
    store: store,
    saveUninitialized: true,
    unset: 'keep',
    cookie: {
        secure: 'auto'
    }
}));

app.use(bodyparser.json());
app.use(bodyparser.urlencoded({
    extended: true
}));
app.use(passport.initialize());
app.use(passport.session());

const cloudant = Cloudant({ vcapServices: JSON.parse(process.env.VCAP_SERVICES), plugins: ['retry429','retry5xx'], maxAttempt: 5 });

cloudant.set_cors({
    enable_cors: true,
    allow_credentials: true,
    origins: ['*']
}, function(err, data) {
    if (err) {
        debug_development(err);
    }
});

passport.use(new WebAppStrategy({
    redirectUri: process.env.MAIN_ROUTE + CALLBACK_URL
}));

userAttributeManager.init({
    profilesUrl: 'https://appid-profiles.eu-gb.bluemix.net'
});
passport.serializeUser(function(user, cb) {
    cb(null, user);
});

passport.deserializeUser(function(obj, cb) {
    cb(null, obj);
});

app.get('/', function(req, res) {
    res.render('index');
});

app.get(LOGIN_URL, passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
    successRedirect: '/home',
    forceLogin: false
}));

app.get(CALLBACK_URL, passport.authenticate(WebAppStrategy.STRATEGY_NAME));

app.get('/register', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {

            return res.render('register', {
                email: req.user.email,
                name: req.user.name,
                picture: req.user.picture
            });

        });

app.get(LOGOUT_URL, function(req, res) {
    WebAppStrategy.logout(req);
    store.cleanupExpired();
    return res.redirect('/');
});

/*
        User's homepage. This page also registers a socket at /notifications namespace.
*/
app.get('/home', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    const accessToken = req.session[WebAppStrategy.AUTH_CONTEXT].accessToken;
    userAttributeManager.getAllAttributes(accessToken, 'firstlogin').then(function(attr) {
        if (!attr.firstlogin) {
            res.redirect('/register');
        } else {
            userAttributeManager.getAttribute(accessToken, 'uid').then(function(attr) {
                let renderOptions = {
                    uid: attr.uid,
                    username: req.user.name,
                    pfp: req.user.picture,
                    email: req.user.email
                };
                res.render('home', renderOptions);

            }).catch(function (err) {
                debug_development(err);
                return res.status(500).render('500');
            });
        }
    }).catch(function (err) {
        debug_development(err);
        return res.render('500');
    });

});

/*
        Called when the question is submitted from the homepage.
        We perform two writes. First we retrieve the user from database using his email.
        Then we insert the question into database and also insert the question id into the user's
        question list.

        On success, we send success:true and the question id
*/
app.post('/submit-question', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    const question_db = cloudant.db.use('questions');
    const user_db = cloudant.db.use('users');
    user_db.find({
        selector: {
            email: req.user.email
        }
    }, function(err, result) {
        if (err || result.docs.length === 0) {
            debug_development(err);
            return res.status(500).send({
                success: false,
                message: 'Something wrong happened.Please try again later'
            });
        }
        /*
            There should be only one user per email id
         */
        let data = result.docs[0];
        let author_id = data._id;
        question_db.insert({
            author: req.user.email,
            title: req.body.title,
            author_name: data.username, //required for showing notification
            details: req.body.details,
            code: req.body.code,
            language: req.body.language,
            author_id: author_id //required for archiving
        }, function(err, body, header) {
            if (err) {
                debug_development(err);
                return res.status(500).send({
                    success: false,
                    message: 'An error occured. Please try again later'
                });
            } else {
                return res.send({
                    success: true,
                    question: body.id
                });
            }

        });
    });

});

/*
        Used for viewing profiles. At this point it just lists all the questions asked
        by the person and his helper stats
*/
app.get('/profile/:profile_id/', function(req, res) {
    const q_db = cloudant.db.use('questions');
    const u_db = cloudant.db.use('users');

    u_db.find({
        selector: {
            _id: req.params.profile_id
        }
    }, function(err, result) {
        if (err) {
            debug_development(err);
            return res.status(500).render('501');
        }

        if (result.docs.length === 0) {
            return res.status(404).render('404');
        }
        const user = result.docs[0];

        return res.render('view_profile', {
            user: user
        });

    });
});

/*
    Used for pagination of the questions in profile pages
*/
app.post('/get-questions', function(req, res) {
    const u_id = req.body.uid;
    const bookmark = req.body.bookmark;
    const q_db = cloudant.db.use('questions');

    q_db.find({
        selector: {
            author_id: u_id
        },
        fields: [
            '_id','title'
        ],
        limit: 10,
        bookmark: bookmark
    }, function(err, result) {
        if (err) {
            debug_development(err);
            return res.status(500).send({ error: true });
        }

        if (result.docs.length === 0) {
            return res.send({ data: 'empty' });
        }

        if (result.docs.length < 10) {
            return res.send({ data: result.docs, has_next: false });
        }

        return res.send({ data: result.docs, has_next: true, bookmark: bookmark });
    });
});
/*
        Used for getting the question title at the profiles page
*/
app.post('/get_question_info/:question_id', function(req, res) {
    const q_db = cloudant.db.use('questions');
    q_db.find({
        selector: {
            _id: req.params.question_id
        },
        fields: ['title']
    }, function(err, result) {
        if (err || result.docs.length === 0) {
            if (err) {
                debug_development(err);
                return res.send({
                    text: 'Can\'t retrieve this question'
                });
            }
            return res.status(404).send({
                success: false,
                text: 'Can\'t retrieve this question'
            });
        }
        return res.send({
            text: result.docs[0].title
        });
    });
});

/*
        Used to view an archived question. If it's not archived yet, return 403
*/
app.get('/view_question/:question_id', function(req, res) {
    const q_db = cloudant.db.use('questions');
    const u_db = cloudant.db.use('users');
    q_db.find({
        selector: {
            _id: req.params.question_id
        }
    }, function(err, result) {
        if (err || result.docs.length === 0) {
            return res.status(500).send('Error');
        }
        let question = result.docs[0];
        if (question.archived) {
            if (question.answer === null) {
                question.answer = 'Sorry, the helper didn\'t provide an answer :-(';
            }
            u_db.find({
                selector: {
                    email: question.helper
                },
                fields: ['_id']
            }, function(err, res1) {
                question.helper_id = res1.docs[0]._id;
                return res.render('view_question', {
                    question: question
                });
            });

        } else {
            return res.status(403).render('403');
        }
    });
});

/*
        Used when an user requests answer to a question.
        The user may come here via two routes, either through a successful submission or
        from their questions page.
        If the question is archived, we send archived:true and this causes the home page
        to redirect to /view_question route. This helps us in using only one type
        of link in profile page irrespective of the archive state.

        If it's not archived, first we check if the user is the author or not. If not, we return 403.

        If everything's ok, we let the author know that we're looking for helper through the socket.

        We search our database for users who have the same language as the question and are online.
        If we find users matching this criteria, we send a notification to first 10.
        If nobody responds after 2 minutes, we let the author know
        #TODO: Increase the limit if none responds.

        The candidates get a notification to see the question and the code. If they accept, we first check
        if it's already accepted or not. If it's accepted, we let them know.

        If everything's ok, we update the question in the database with the helper's data and give
        the author and the helper signal to proceed
*/

const found = {};
const t_out = {};
app.post('/question/:question_id', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    const q_db = cloudant.db.use('questions');
    const u_db = cloudant.db.use('users');
    debug_development('Checkpoint 1');
    q_db.find({
        selector: {
            _id: req.params.question_id
        }
    }, function(err, result) {
        if (err) {
            debug_development(err);
            return res.status(500).send({
                success: false,
                message: 'An error occured'
            });
        } else if (result.docs.length === 0) {
            res.status(404).send({
                success: false,
                message: 'Invalid id'
            });
        } else {
            var question = result.docs[0];
            if (question.archived) {
                res.send({
                    success: true,
                    archived: true,
                    question: question._id
                });
            } else {

                if (req.user.email !== question.author) {
                    return res.status(403).render('403');
                }
                res.send({
                    success: true,
                    archived: false,
                    question: question._id
                });
                let author = question.author;
                t_out[question._id] = false;
                found[question._id] = false;
                // connections[author].emit('looking_for_helper');
                /*
                    If nobody replies after 2 minutes, let the author know
                 */
                let t = setTimeout(function() {
                    t_out[question._id] = true;
                    if (typeof connections[author] !== 'undefined') {
                        connections[author].emit('timeout');
                    }
                    q_db.destroy(question._id, question._rev, function(err1, data) {

                    });
                }, 2000 * 60);
                debug_development('Checkpoint 2');
                u_db.find({
                    selector: {
                        language: {
                            $in: [question.language]
                        },
                        online: true
                    },
                    fields: ['_id', 'email'],
                    limit: 10
                }, function(errx, uresult) {
                    debug_development(uresult);
                    if (errx || uresult.docs.length === 0) {
                        if (errx) {
                            debug_development(errx);
                        }
                        clearTimeout(t);
                        /*
                            Before emitting make sure that the author hasn't left
                         */
                        if (typeof connections[author] !== 'undefined') {
                            connections[author].emit('error_while_finding');
                        }
                    } else {
                        let lim = (uresult.docs.length < 10) ? uresult.docs.length : 10;
                        for (let i = 0; i < lim; ++i) {
                         
                            if (found[question._id] || t_out[question._id]) {
                            
                                // No need to continue if already found or timed out
                                break;
                            }
                            const target = uresult.docs[i].email;
                            if (target === author) {
                                continue;
                            }
                            /*
                                Before emitting, make sure the user's still there
                             */
                            if (typeof connections[target] === 'undefined') {
                           
                                continue;
                            }
                           
                            connections[target].emit('ask_help', {
                                question: question
                            }, function(question, email, name, accepted) {
                                if (accepted) {
                                    debug_development('found=' + found[question._id]);
                                    debug_development('t_out= ' + t_out[question._id]);
                                    if (found[question._id] || t_out[question._id]) {
                                        /*
                                            The user accepted, but we already found one or timed out
                                         */
                                        if (typeof connections[email] !== 'undefined') {

                                            connections[email].emit('already_accepted', {
                                                question: question
                                            });
                                        }

                                    } else {
                                        found[question._id] = true;
                                        clearTimeout(t);
                                        question.helper = email;
                                        question.helper_name = name;
                                        /*
                                            Update the database
                                         */
                                        q_db.insert(question, function(erry, body, header) {
                                            if (typeof connections[author] === 'undefined') {
                                                /*
                                                    If the author has already left,
                                                    we tell the user that it's already accepted,
                                                    which is a lie.

                                                    The question in the database will still have
                                                    the name of the helper, but I think it's not
                                                    a problem since if the author tries again, it
                                                    will be overwritten
                                                 */
                                                if (typeof connections[email] !== 'undefined') {
                                                    return connections[email].emit('already_accepted', {
                                                        question: question
                                                    });
                                                }

                                            }
                                            /*
                                                Let the author know we found a helper
                                             */
                                            connections[author].emit('helper_found', {
                                                question: body.id
                                            });

                                            /*
                                                #TODO: What happens if the helper left at this point?
                                             */
                                            connections[email].emit('accept', {
                                                question: body.id
                                            });

                                        });
                                    }
                                }
                            });
                        }
                    }
                });
            }
        }
    });
});

/*
    Listing of suggested paths.
 */
// app.get('/paths/:lang', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
//     const p_db = cloudant.db.use('paths');
//     const u_db = cloudant.db.use('users');
//     p_db.find({
//         selector: {
//             language: {
//                 $in: [req.params.lang]
//             }
//         }
//     }, function(err, result) {
//         if (err) {
//             return res.status(500).render('500');
//         }
//         if (result.docs.length === 0) {
//             return res.status(400).render('400');
//         }
//
//         return res.render('path', {
//             paths:  result.docs
//         });
//     });
// });

/*
        This is the route where the user will chat.
        If the question is archived, we redirect to /view_question route.
        Here only the author and helper has entry. For anyone else, we send a 403
*/

app.get('/chat/:question_id', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    const q_db = cloudant.db.use('questions');
    const u_db = cloudant.db.use('users');
    delete found[req.params.question_id];
    delete t_out[req.params.question_id];
    q_db.find({
        selector: {
            _id: req.params.question_id
        }
    }, function(err, result) {
        if (err || result.docs.length === 0) {
            if (err) {
                debug_development(err);
                return res.status(500).render('500');
            }

            return res.status(404).render('404');
        }
        /*
            There should be only one question per id
         */
        const question = result.docs[0];
        if (question.archived) {
            return res.redirect('/view_question/' + question._id);
        }

        if (req.user.email === question.author) {

            u_db.find({
                selector: {
                    email: question.helper
                }
            }, function(err, result) {
                if (err || result.docs.length === 0) {
                    if (err) {
                        debug_development(err);

                        return res.status(500).render('500');
                    }
                    return res.status(404).render('404');
                }
                return res.render('chat', {
                    question: question,
                    email: req.user.email,
                    name: result.docs[0].username, //name of helper
                    picture: result.docs[0].picture, //picture of helper
                    helper: false
                });
            });

        } else if (req.user.email === question.helper) {
            u_db.find({
                selector: {
                    email: question.author
                }
            }, function(err, result) {
                if (err || result.docs.length === 0) {
                    if (err) {
                        debug_development(err);

                        return res.status(500).render('500');
                    }
                    return res.status(404).render('404');
                }
                return res.render('chat', {
                    question: question,
                    email: req.user.email,
                    name: result.docs[0].username, //name of author
                    picture: result.docs[0].picture, //picture of author,

                    helper: true
                });
            });
        } else {
            return res.status(403).render('403');
        }
    });
});

app.get('/reset', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    const accessToken = req.session[WebAppStrategy.AUTH_CONTEXT].accessToken;
    userAttributeManager.deleteAttribute(accessToken, 'firstlogin').then(function() {
        res.redirect('/');
    });
});

/*
        Used to update the details of the user from the register page.
        We create three field: "helped" => number of users helped
        "stars" => reviews by the users
        "level" => level of the user

        #TODO: Add more stats
*/
app.post('/update-user-details', passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    const lang = req.body.lang;
    const accessToken = req.session[WebAppStrategy.AUTH_CONTEXT].accessToken;
    userAttributeManager.setAttribute(accessToken, 'firstlogin', 'false').then(function(attributes) {
        const user_db = cloudant.db.use('users');
        user_db.insert({
            username: req.user.name,
            email: req.user.email,
            picture: req.user.picture,
            helper_stats: {
                helped: 0,
                stars: 0,
                level: 'Beginner'
            },

            language: lang
        }, function(err, body, header) {
            if (err) {
                debug_development(err);
                res.status(500).send({
                    success: false
                });

            } else {
                /*
                    We set the user id.
                    This is required to set the homepage.
                 */
                userAttributeManager.setAttribute(accessToken, 'uid', body.id).then(function(attr) {
                    res.send({
                        success: true
                    });
                }).catch(function (err) {
                    res.send({
                        success: false
                    })
                });

            }
        });

    }).catch(function (err) {
        debug_development(err);
    });
});

/*
        Feedback page
*/
app.get('/feedback', function(req, res) {
    return res.render('suggestion');
});

/*
        Submit the suggestion. For now does nothing.
        #TODO: Probably add the suggestions into a database.
*/
app.post('/submit_suggestion', function(req, res) {
    res.send({
        success: true
    });
});

/*
    404
 */
app.use(function(req, res, next) {
    res.status(404);
    // respond with html page
    if (req.xhr) {
       
        return res.send('Not found');
    }
    return res.render('404');
});

/*
    500
 */
app.use(function(err, req, res, next) {
    debug_development(err);
    res.status(500);
    if (req.xhr) {
        return res.send('Internal server error');
    }
    return res.render('500');
});

/*
        Notification sockets.
        As soon as a user connects, we put the sockets in the connections hash along with the email.
        Once a user disconnects, we delete the entry.


        #TODO: Find a better way
        #TODO: Make notifications work in pages outside home
*/
io.of('/notification').use(function(socket, next) {
    const email = decodeURIComponent(socket.handshake.query.email);
    const u_db = cloudant.db.use('users');
    u_db.find({
        selector: {
            email: email
        }
    }, function(err, result) {
        if (err || result.docs.length === 0) {
            if (err) {
                debug_development('ERROR finding user: ' + err);
            }
            return socket.emit('error_registering', {
                message: 'Something went wrong with registering notification socket'
            });
        }
        //There should be only one user per email id
        let user = result.docs[0];
        user.online = true;
        u_db.insert(user, function(err1, body, header) {
            if (err1) {
                debug_development(err1);
            }
        });
    });
    socket.on('disconnect', function(reason) {
        delete connections[email];
        const u_db = cloudant.db.use('users');
        u_db.find({
            selector: {
                email: email
            }
        }, function(err, result) {
            if (err || result.docs.length === 0) {
                if (err) {
                    debug_development(err);
                    return; //For now, it silently ignores any error
                }
            }
            let user = result.docs[0];
            user.online = false;
            u_db.insert(user, function(err1, body, header) {
                if (err) {
                    debug_development(err1);
                }
            });
        });
    });
    connections[email] = socket;
    next();
    //    logger.info(connections);
});

/*
        This is where the sockets are registered during chat
*/

io.of('/help').on('connection', function(socket) {
    const question_id = socket.handshake.query.question;
    socket.join(question_id);

    socket.on('disconnect', function() {
        socket.to(question_id).broadcast.emit('user_left');
    });
    /*
        When someone sends a message
     */
    socket.on('chat_send', function(msg) {
        socket.to(question_id).broadcast.emit('chat_recieved', msg);
    });
    /*
        When any change occurs in the editor
     */
    socket.on('update_editor', function(data) {
        socket.to(question_id).broadcast.emit('update', data);
    });
    socket.on('author_info', function(data) {
        socket.to(question_id).broadcast.emit('user_connected', {
            name: data.name,
            picture: data.picture
        });
    });

    /*
        When the author wants to end the chat
     */
    socket.on('end_request', function(data) {
        /*
            Ask the helper for answer
         */
        socket.to(question_id).broadcast.emit('ask_helper_for_answer', data);
    });

    /*
        The helper provided his answer.
        We update the question in the database.
        Remember, it's optional for the helper to provide an answer.
        In that case, a null is posted
     */
    socket.on('chat_ended', function(data) {
        const question = data.question;
        const helper = data.helper;
        const q_db = cloudant.db.use('questions');
        const u_db = cloudant.db.use('users');
        q_db.insert(question, function(err, body, header) {
            if (err) {
                debug_development(err);
            }
            u_db.find({
                selector: {
                    email: helper
                }
            }, function(err, result) {
                if (err) {
                    return debug_development(err);
                }
                let user = result.docs[0];
                user.helper_stats.helped += 1;
                user.helper_stats.stars += data.rating;
                if (question.answer !== null) {
                    user.helper_stats.stars += reward_for_answer;
                    user.helper_stats.level = getLevel(user.helper_stats.stars);
                } else {
                    user.helper_stats.level = getLevel(user.helper_stats.stars);
                }

                u_db.insert(user, function(err, body, header) {
                    if (err) {
                        debug_development(err);
                    }
                });
            });

        });
        socket.to(question_id).emit('end_chat');
    });

});

process.on('unhandledRejection', (reason, p) => {
    debug_development('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
});

http.listen(port, function() {
    logger.info('Listening on port: ' + port);
});

