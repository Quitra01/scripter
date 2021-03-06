import RedisWrapper from '../../shared/redis/client'
import { v4 as uuid } from 'uuid';
import { fork } from 'child_process';
import os from 'os';
import Logger from '../../shared/logger/logger';
import constants, { GameTickPhase } from '../../shared/constants/constants';
import { ScriptExecutionMessage } from '../../shared/redis/messages/scriptExecutionMessage';
import { Player } from '../../shared/mongodb/schemas/player';
import { IntentExecutionMessage } from '../../shared/redis/messages/intentExecutionMessage';

if (process.env.NODE_ENV !== 'production') {
    // tslint:disable-next-line
    require('dotenv').config()
}

const cpuCount = os.cpus().length

const logger = new Logger()
const runnerFile = `${__dirname}/runner/runner.js`

const hostId: string = uuid();
const hostChannel = `${hostId}@hosts`

const redisSubscriber = new RedisWrapper()
const redisSender = new RedisWrapper()

const timeout = 400;

const numberOfRunners = cpuCount;
logger.info(`cpuCount is ${cpuCount}, setting number of runners to ${numberOfRunners}`)

let idleRunnerCodes: string[] = []

const executionsRunning: any = {}

const runnerProcesses: any = {}
let totalTimeouts = 0;
let totalCompletes = 0;
let maxRunnerIndex = 0;

process.on('SIGINT', () => {
    process.exit()
});

async function makeKeepAliveCall() {
    redisSender.hset(constants.DispatchersKey, hostId, JSON.stringify({ id: hostId, keepAlive: new Date().toISOString(), currentlyWorkingRunners: Object.keys(executionsRunning).length, totalCompletes }));
}

async function sendNext(nextJobString: string, hostNumber: string, currentPhase: GameTickPhase) {
    const executionId: string = uuid();
    executionsRunning[executionId] = true;
    runnerProcesses[hostNumber].lastExecutionStartDate = new Date();
    const nextJobObj = JSON.parse(nextJobString);
    switch (currentPhase) {
        case GameTickPhase.ScriptPhase:
            const player: Player = new Player(nextJobObj);
            await redisSender.publish(`${hostChannel}:${hostNumber}`, JSON.stringify(new ScriptExecutionMessage(executionId, player)))
            break;
        case GameTickPhase.ResultProcessingPhase:
            await redisSender.publish(`${hostChannel}:${hostNumber}`, JSON.stringify(new IntentExecutionMessage(executionId, nextJobString)))
            break;
        default:
            break;
    }
    const startTimestamp = new Date().getTime()
    runnerProcesses[hostNumber].timeout = setTimeout(() => {
        try {
            const timePassed = (new Date().getTime() - startTimestamp);
            logger.debug(`Timeout has come for ${hostNumber} with ${executionsRunning[executionId]} after ${timePassed} ms`)
            if (runnerProcesses[hostNumber] && (!(runnerProcesses[hostNumber].lastExecutionEndDate) || (runnerProcesses[hostNumber].lastExecutionEndDate - runnerProcesses[hostNumber].lastExecutionStartDate) < 1 && (new Date().getTime() - runnerProcesses[hostNumber].lastExecutionStartDate.getTime()) > timeout - 10)) {
                totalTimeouts += 1;
                const result = runnerProcesses[hostNumber].runner.kill('SIGTERM')
                logger.debug(`Kill result: ${result}`);
                logger.debug("Cleaning up runnerProcess list.")
                delete runnerProcesses[hostNumber]
                logger.debug(`Cleaning up Executions running list with ${executionId} as ${executionsRunning[executionId]}`)
                delete executionsRunning[executionId];
                logger.debug(`Length of executionsRunning Array: ${Object.keys(executionsRunning).length}`)
                logger.debug("Starting new runner!")
                const runnerIndex = maxRunnerIndex + 1;
                const runner = startRunner(runnerIndex)
                maxRunnerIndex = runnerIndex;
                runnerProcesses[runnerIndex.toString()] = { runner };
                redisSender.increaseBy(constants.TotalScriptExecutionTimeKey, timePassed);
                redisSender.increaseBy(constants.TotalNumberOfScriptExecutionsKey, 1);
                makeKeepAliveCall()
            }
        }
        catch (err) {
            logger.error(err)
        }
    }, timeout);
}

async function onRunnerMessage(message: string, channel: string) {
    const currentPhase = GameTickPhase[await redisSender.get(constants.Phase) as keyof typeof GameTickPhase];
    if (channel === hostChannel) {
        const messageStart = message.split(":")[0]
        const hostNumber = message.split(":")[1]
        switch (messageStart) {
            case "ready":
                try {
                    if (message.split(":").length > 2) {
                        totalCompletes += 1
                        const lastExecution = message.split(":")[2]
                        const running = executionsRunning[lastExecution]
                        if (running) {
                            delete executionsRunning[lastExecution]
                        }

                        if (runnerProcesses[hostNumber] !== undefined) {
                            logger.debug(`Runner ${hostNumber} done in ${new Date().getTime() - runnerProcesses[hostNumber].lastExecutionStartDate}.`)
                            clearTimeout(runnerProcesses[hostNumber].timeout)
                            runnerProcesses[hostNumber].lastExecutionEndDate = new Date();
                        } else {
                            logger.info("Answer after timeout!")
                            return;
                        }
                    }
                    let nextJobString: string;
                    if (currentPhase === GameTickPhase.ScriptPhase) {
                        nextJobString = await redisSender.pop(constants.ScriptsToProcess);
                    } else {
                        nextJobString = await redisSender.pop(constants.MapsToProcess);
                    }

                    if (!nextJobString) {
                        idleRunnerCodes.push(hostNumber);
                    }
                    if (nextJobString) {
                        sendNext(nextJobString, hostNumber, currentPhase)
                    } else if (Object.keys(executionsRunning).length === 0) {
                        await makeKeepAliveCall()
                        dispatchTasks(currentPhase)
                    }


                } catch (err) {
                    logger.debug("List is already empty! Cancelling add new process!")
                }
                break;
            default:
                break;
        }
    }
}

async function onPhaseChange(message: string, channel: string) {
    logger.debug(`Receiver Phase Change, New Phase : ${message}`)
    dispatchTasks(GameTickPhase[message as keyof typeof GameTickPhase])
}

async function dispatchTasks(currentPhase: GameTickPhase) {
    let listName = constants.ScriptsToProcess;
    if (currentPhase === GameTickPhase.ResultProcessingPhase) {
        listName = constants.MapsToProcess;
    }
    const listLength = await redisSender.length(listName);

    if (listLength > 0) {
        idleRunnerCodes.map(async (code) => {
            const nextJobString = await redisSender.pop(listName);
            if (nextJobString) {
                sendNext(nextJobString, code, currentPhase)
            }
        })
        idleRunnerCodes = [];
    }
}

async function main() {
    await redisSubscriber.subscribe(hostChannel, onRunnerMessage);
    await redisSubscriber.subscribe(constants.PhaseChangedChannel, onPhaseChange);

    await makeKeepAliveCall();
    setInterval(() => {
        makeKeepAliveCall();
    }, constants.DispatchersKeepaliveSendInterval)
    for (let runnerIndex = 0; runnerIndex < numberOfRunners; runnerIndex++) {
        const runner = startRunner(runnerIndex)
        maxRunnerIndex = runnerIndex;
        runnerProcesses[runnerIndex.toString()] = { runner };
    }
}

function startRunner(runnerIndex: number) {
    // TODO: Find a way to properly inherit dispatcher env
    return fork(runnerFile, [hostChannel, runnerIndex.toString()], { env: { "REDIS_URL": "localhost" } });
}

if (require.main === module) {
    main();

}
