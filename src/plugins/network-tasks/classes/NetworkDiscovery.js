const cluster       = require('cluster');
const EventEmitter  = require('events');
const fs            = require('fs');
const Path          = require('path');
const airswarm      = plugins.require('network-tasks/AirswarmTls');
const TasksManager  = plugins.require('network-tasks/TasksManager');
const NetWorker     = plugins.require('network-tasks/NetWorker');

class NetworkDiscovery extends EventEmitter {

    constructor(identifier) {
        super();

        this.threads              = 0;
        this.workers              = [];
        this.tasksManager         = new TasksManager(this);
        this.incrementalWorkIndex = 0;

        console.info('Seting up network discovery with identifier', identifier);

        const tlsOptions = {
            key: fs.readFileSync(Path.join(process.cwd(), 'ssl', 'cert-key.pem')),
            cert: fs.readFileSync(Path.join(process.cwd(), 'ssl', 'cert.pem')),
            requestCert: true,
            ca: fs.readFileSync(Path.join(process.cwd(), 'ssl', 'ca.pem'))
        };

        this.server = airswarm(tlsOptions, identifier, function(sock) {
            try {
                this.onSocket(sock);
                this.emit('socket', sock);
            }
            catch(e) {
                console.error(e);
            }
        }.bind(this));
    }

    registerWorker(worker) {
        this.threads++;

        const netWorker = new NetWorker(this);
        netWorker.setWorker(worker);

        this.workers.push(netWorker);

        const peers = this.getPeers();

        for(var key in peers)
            peers[key].send('threads', this.threads);
    }

    onSocket(socket) {
        const netWorker = new NetWorker(this);
        netWorker.setSocket(socket);

        this.workers.push(netWorker);

        socket.once('close', function() {
            const index = this.workers.indexOf(netWorker);

            if (index > -1)
                this.workers.splice(index, 1);
        }.bind(this));

        netWorker.send('threads', this.threads);
    }

    getPeers() {
        return this.workers.filter(function(obj) {
            return obj.socket ? true : false;
        });
    }

    getInternalWorkers() {
        return this.workers.filter(function(obj) {
            return obj.worker ? true : false;
        });
    }

    //------------------------------

    getThreads() {
        if(this.workers.length === 0)
            return 0;

        if(this.workers.length === 1)
            return this.workers[0].threads;

        return this.workers.map(function(obj) {
            return obj.threads;
        }).reduce(function(a, b) {
            return a + b;
        });
    }

    getNextSocket() {
        const threads = this.getThreads();

        if(threads === 0)
            return null;

        const index   = this.incrementalWorkIndex >= threads ? 0 : this.incrementalWorkIndex;
        this.incrementalWorkIndex = index + 1;

        var i = 0;
        for(var key in this.workers) {
            if(this.workers[key].threads + i > index)
                return this.workers[key];

            i += this.workers[key].threads;
        }

        return null;
    }

    //------------------------------

    distributeJob(name, params) {
        return this.jobsManager.distribute(name, params);
    }

    distributeTask(name, params) {
        return this.tasksManager.distribute(name, params);
    }

    //------------------------------

}




//---------------------------------------------------

class SlaveDiscovery extends EventEmitter {

    constructor() {
        super();
        this.taskHandlers   = {};
        this.wrapperWaiters = {};

        process.on('message', function(msg) {
            if(typeof(msg) === 'string') {
                try {
                    msg = JSON.parse(msg);
                } catch(e) {
                    return;
                }
            }

            if(msg.event)
                this.emit(msg.event, msg.argv);
        }.bind(this));

        this.on('task', this.handleTask);
        this.on('task-response', this.handleWrapperResponse);
    }

    send(event, argv) {
        this.emit(event, argv);
        process.send({
            event: event,
            argv: argv
        });
    }

    handleTask(argv) {
        const _this = this;

        function sendTaskResult(type, data) {
            const p = { id: argv.id };
            p[type] = data;

            _this.send('task-response', p);
        }

        if(!this.taskHandlers[argv.name])
            return sendTaskResult('error', 'No task handler found for the required task: ' + argv.name);

        const result = this.taskHandlers[argv.name](argv.params || {});

        if(!result.then)
            return sendTaskResult('result', result);

        result.then(function(obj) {
            sendTaskResult('result', obj);
        }).catch(function(err) {
            if(err.error)
                return sendTaskResult('error', err.error);
            else if(err.message)
                return sendTaskResult('error', err.message);

            sendTaskResult('error', err);
        })
    }

    onTask(name, cb) {
        this.taskHandlers[name] = cb;
    }

    //-----------------

    createMasterWrapper(event, subName, params) {
        const _this = this;
        return new Promise(function(resolve, reject) {
            const id  = event + '_' + subName + '_' + Math.random() + 'work' + Math.random();

            _this.wrapperWaiters[id] = function(argv) {
                if(argv.error)
                    reject(argv.error);
                else
                    resolve(argv.result);
            }

            _this.send(event, {
                id:     id,
                name:   subName,
                params: params
            });
        });
    }

    distributeTask(name, params) {
        return this.createMasterWrapper('task', name, params);
    }

    distributeJob(name, params) {
        return this.createMasterWrapper('job', name, params);
    }

    handleWrapperResponse(argv) {
        if(argv.id)
        {
            if(this.wrapperWaiters[argv.id])
                this.wrapperWaiters[argv.id](argv);
        }
    }
}



//---------------------------------------------------

NetworkDiscovery.Create = function(identifier) {
    if(cluster.isMaster)
    {
        const req = plugins.require('network-tasks/NetworkDiscovery');
        return new req(identifier);
    }

    return new SlaveDiscovery();
}

module.exports = NetworkDiscovery;