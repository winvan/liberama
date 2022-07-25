const fs = require('fs-extra');

const FileDownloader = require('../FileDownloader');
const JembaConnManager = require('../../db/JembaConnManager');//singleton

const ayncExit = new (require('../AsyncExit'))();
const utils = require('../utils');
const log = new (require('../AppLogger'))().log;//singleton

const minuteMs = 60*1000;
const hourMs = 60*minuteMs;
const dayMs = 24*hourMs;

let instance = null;

//singleton
class BUCServer {
    constructor(config) {
        if (!instance) {
            this.config = Object.assign({}, config);

            //константы
            if (this.config.branch !== 'development') {
                this.maxCheckQueueLength = 10000;//максимальная длина checkQueue
                this.fillCheckQueuePeriod = 1*minuteMs;//период пополнения очереди
                this.periodicCheckWait = 500;//пауза, если нечего делать

                this.cleanQueryInterval = 300*dayMs;//интервал очистки устаревших
                this.oldQueryInterval = 30*dayMs;//интервал устаревания запроса на обновление
                this.checkingInterval = 3*hourMs;//интервал проверки обновления одного и того же файла
                this.sameHostCheckInterval = 1000;//интервал проверки файла на том же сайте, не менее
            } else {
                this.maxCheckQueueLength = 10;//максимальная длина checkQueue
                this.fillCheckQueuePeriod = 10*1000;//период пополнения очереди
                this.periodicCheckWait = 500;//пауза, если нечего делать

                this.cleanQueryInterval = 100*1000;//10*minuteMs;//интервал очистки устаревших
                this.oldQueryInterval = 5*minuteMs;//интервал устаревания запроса на обновление
                this.checkingInterval = 30*1000;//интервал проверки обновления одного и того же файла
                this.sameHostCheckInterval = 1000;//интервал проверки файла на том же сайте, не менее
            }

            
            this.config.tempDownloadDir = `${config.tempDir}/download`;
            fs.ensureDirSync(this.config.tempDownloadDir);

            this.down = new FileDownloader(config.maxUploadFileSize);            

            this.connManager = new JembaConnManager();
            this.db = this.connManager.db['book-update-server'];
            
            this.checkQueue = [];
            this.hostChecking = {};

            instance = this;
        }

        return instance;
    }

    async fillCheckQueue() {
        const db = this.db;

        while (1) {//eslint-disable-line
            try {
                let now = Date.now();

                //чистка совсем устаревших
                let rows = await db.select({
                    table: 'buc',
                    where: `@@dirtyIndexLR('queryTime', undefined, ${db.esc(now - this.cleanQueryInterval)})`
                });

                if (rows.length) {
                    const ids = rows.map((r) => r.id);
                    const res = await db.delete({
                        table: 'buc',
                        where: `@@id(${db.esc(ids)})`,
                    });

                    log(LM_WARN, `clean 'buc' table: deleted ${res.deleted}`);
                }

                rows = await db.select({table: 'buc', count: true});
                log(LM_WARN, `'buc' table length: ${rows[0].count}`);

rows = await db.select({table: 'buc'});
console.log(rows);

                now = Date.now();
                //выборка кандидатов
                rows = await db.select({
                    table: 'buc',
                    where: `
                        @@and(
                            @dirtyIndexLR('queryTime', ${db.esc(now - this.oldQueryInterval)}),
                            @dirtyIndexLR('checkTime', undefined, ${db.esc(now - this.checkingInterval)}),
                            @flag('notProcessing')
                        );
                    `
                });

                if (rows.length) {
                    const ids = [];

                    for (let i = 0; i < rows.length; i++) {
                        if (this.checkQueue.length >= this.maxCheckQueueLength)
                            break;

                        const row = rows[i];
                        ids.push(row.id);
                        this.checkQueue.push(row);
                    }

                    await db.update({
                        table: 'buc',
                        mod: `(r) => r.state = 1`,
                        where: `@@id(${db.esc(ids)})`
                    });
                    
                    log(LM_WARN, `checkQueue: added ${ids.length} recs, total ${this.checkQueue.length}`);
                }
            } catch(e) {
                log(LM_ERR, e.stack);
            }

            await utils.sleep(this.fillCheckQueuePeriod);
        }
    }

    async periodicCheck() {
        const db = this.db;

        while (1) {//eslint-disable-line
            try {
                if (!this.checkQueue.length)
                    await utils.sleep(this.periodicCheckWait);

                if (!this.checkQueue.length)
                    continue;

                const row = this.checkQueue.shift();

                const url = new URL(row.id);

                //только если обращались к тому же хосту не ранее sameHostCheckInterval миллисекунд назад
                if (!this.hostChecking[url.hostname]) {
                    this.hostChecking[url.hostname] = true;

                    try {
                        const downdata = await this.down.load(row.id);
                        const hash = await utils.getBufHash(downdata, 'sha256', 'hex');

                        await db.update({
                            table: 'buc',
                            mod: `(r) => {
                                r.checkTime = ${db.esc(Date.now())};
                                r.size = ${db.esc(downdata.length)};
                                r.checkSum = ${db.esc(hash)};
                                r.state = 0;
                                r.error = '';
                            }`,
                            where: `@@id(${db.esc(row.id)})`
                        });

                        log(`checked ${row.id} > size ${downdata.length}`);
                    } catch (e) {
                        await db.update({
                            table: 'buc',
                            mod: `(r) => {
                                r.checkTime = ${db.esc(Date.now())};
                                r.state = 0;
                                r.error = ${db.esc(e.message)};
                            }`,
                            where: `@@id(${db.esc(row.id)})`
                        });
                    } finally {
                        (async() => {
                            await utils.sleep(this.sameHostCheckInterval);
                            this.hostChecking[url.hostname] = false;
                        })();
                    }
                } else {
                    this.checkQueue.push(row);
                }
            } catch(e) {
                log(LM_ERR, e.stack);
            }

            await utils.sleep(10);
        }
    }

    async main() {
        try {
            //обнуляем все статусы
            await this.db.update({table: 'buc', mod: `(r) => r.state = 0`});
/*
await this.db.insert({
    table: 'buc',
    replace: true,
    rows: [
        {
            id: 'http://old.omnireader.ru/test.txt', // book URL
            queryTime: Date.now(),
            checkTime: 0, // 0 - never checked
            size: 0,
            checkSum: '', //sha256
            state: 0, // 0 - not processing, 1 - processing
            error: '',
        }
    ],
});
*/
            this.fillCheckQueue();//no await

            //10 потоков
            for (let i = 0; i < 10; i++)
                this.periodicCheck();//no await

            log(`---------------------------`);
            log(`Book Update checker started`);
            log(`---------------------------`);
        } catch (e) {
            log(LM_FATAL, e.stack);
            ayncExit.exit(1);
        }
    }
}

module.exports = BUCServer;