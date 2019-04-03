/**
 * @module botkit
 */
import { Botkit } from './core';
import { BotkitDialogWrapper } from './cms';
import { ActivityTypes, TurnContext, MessageFactory, ActionTypes, ConsoleTranscriptLogger } from 'botbuilder';
import { Dialog, DialogContext, DialogInstance, DialogReason, TextPrompt, DialogTurnStatus } from 'botbuilder-dialogs';
const debug = require('debug')('botkit:conversation');
import * as mustache from 'mustache';
export class BotkitConversation<O extends object = {}> extends Dialog<O> {

    public script: any;
    private _prompt: string;
    private _beforeHooks: {};
    private _afterHooks: { (context: TurnContext, results: any): void }[];
    private _changeHooks: {};
    private _controller: Botkit;

    constructor(dialogId: string, controller) {
        super(dialogId);

        this._beforeHooks = {};
        this._afterHooks = [];
        this._changeHooks = {};
        this.script = {};

        this._controller = controller;

        // Make sure there is a prompt we can use. 
        // TODO: maybe this ends up being managed by Botkit
        this._prompt = this.id + '_default_prompt';
        this._controller.dialogSet.add(new TextPrompt(this._prompt));

        return this;

    }

    public say(message) {
        this.addMessage(message, 'default');
    }

    public addMessage(message, thread_name) {
        if (!thread_name) {
            thread_name = 'default';
        }

        if (!this.script[thread_name]) {
            this.script[thread_name] = [];
        }

        if (typeof(message)==='string') {
            message = { text: [message] };
        }

        this.script[thread_name].push(message);
    }

    public ask(message, handlers, options) {
        this.addQuestion(message, handlers, options, 'default');
    }

    public addQuestion(message, handlers, options, thread_name) {

        if (!thread_name) {
            thread_name = 'default';
        }

        if (!this.script[thread_name]) {
            this.script[thread_name] = [];
        }

        if (typeof(message)==='string') {
            message = { text: [message] };
        }

        message.collect = {
            key: options.key
        };

        if (Array.isArray(handlers)) {
            message.collect.options = handlers;
        } else if (typeof(handlers) === 'function') {
            message.collect.options = [
                {
                    default: true,
                    handler: handlers
                }
            ];
        }

        // ensure all options have a type field
        message.collect.options.forEach((o) => { if (!o.type) { o.type = 'string'; }});

        this.script[thread_name].push(message);
    }

    public before(thread_name, handler) {
        if (!this._beforeHooks[thread_name]) {
            this._beforeHooks[thread_name] = [];
        }

        this._beforeHooks[thread_name].push(handler);
    }

    private async runBefore(thread_name, dc, step) {
        debug('Before:', this.id, thread_name);
        // let convo = new BotkitConvo(dc, step);
        
        if (this._beforeHooks[thread_name]) {

            // spawn a bot instance so devs can use API or other stuff as necessary
            const bot = await this._controller.spawn(dc);

            // create a convo controller object
            const convo = new BotkitDialogWrapper(dc, step);

            for (let h = 0; h < this._beforeHooks[thread_name].length; h++ ){
                let handler = this._beforeHooks[thread_name][h];
                await handler.call(this, convo, bot);
                // await handler.call(this, d);
            }
        }
    }    
    
    public after(handler: (context: TurnContext, results: any) => void) {
        this._afterHooks.push(handler);
    }

    private async runAfter(context, results) {
        debug('After:', this.id);
        if (this._afterHooks.length) {
            const bot = await this._controller.spawn(context);
            for (let h = 0; h < this._afterHooks.length; h++ ){
                let handler = this._afterHooks[h];

                await handler.call(this, results, bot);
            }
        }
    }

    public onChange(variable, handler) {
        if (!this._changeHooks[variable]) {
            this._changeHooks[variable] = [];
        }

        this._changeHooks[variable].push(handler);
    }

    private async runOnChange(variable, value, dc, step) {
        debug('OnChange:', this.id, variable);

        if (this._changeHooks[variable] && this._changeHooks[variable].length) {

            // spawn a bot instance so devs can use API or other stuff as necessary
            const bot = await this._controller.spawn(dc);

            // create a convo controller object
            const convo = new BotkitDialogWrapper(dc, step);

            for (let h = 0; h < this._changeHooks[variable].length; h++ ){
                let handler = this._changeHooks[variable][h];
                // await handler.call(this, value, convo);
                await handler.call(this, value, convo, bot);
            }
        }
    }

    async beginDialog(dc, options) {
        // Initialize the state
        const state = dc.activeDialog.state;
        state.options = options || {};
        state.values = {...options};

        // Run the first step
        return await this.runStep(dc, 0, state.options.thread || 'default', DialogReason.beginCalled);
    }

    async continueDialog(dc) {

        // Don't do anything for non-message activities
        if (dc.context.activity.type !== ActivityTypes.Message) {
            return Dialog.EndOfTurn;
        }


        // Run next step with the message text as the result.
        return await this.resumeDialog(dc, DialogReason.continueCalled, dc.context.activity.text);
    }

    async resumeDialog(dc, reason, result) {
        // Increment step index and run step
        const state = dc.activeDialog.state;
        return await this.runStep(dc, state.stepIndex + 1, state.thread, reason, result);
    }

    async onStep(dc, step) {

        // Let's interpret the current line of the script.
        const thread = this.script[step.thread];
        let line = thread[step.index];

        var previous = (step.index >= 1) ? thread[step.index - 1] : null;
        // Capture the previous step value if there previous line included a prompt
        if (step.result && previous && previous.collect) {
            if (previous.collect.key) {
                // capture before values
                let index = step.index;
                let thread_name = step.thread;

                // capture the user input value into the array 
                if (step.values[previous.collect.key] && previous.collect.multiple) {
                    step.values[previous.collect.key] = [ step.values[previous.collect.key], step.result ].join('\n');
                } else {
                    step.values[previous.collect.key] = step.result;
                }

                // run onChange handlers
                await this.runOnChange(previous.collect.key, step.result, dc, step);

                // did we just change threads? if so, restart this turn
                if (index != step.index || thread_name != step.thread) {
                    return await this.runStep(dc, step.index, step.thread, DialogReason.nextCalled, step.values);
                }
            }

            // handle conditions of previous step
            if (previous.collect.options) {
                var paths = previous.collect.options.filter((option) => { return !option.default===true; });
                var default_path = previous.collect.options.filter((option) => { return option.default===true; })[0];
                var path = null;

                for (let p = 0; p < paths.length; p++) {
                    let condition = paths[p];
                    let test;
                    if (condition.type === 'string') {
                        test = new RegExp(condition.pattern,'i');
                    } else if (condition.type === 'regex') {
                        test = new RegExp(condition.pattern,'i');
                    }

                    if (step.result.match(test)) {
                        path = condition;
                        break;
                    }
                }

                // take default path if one is set
                if (!path) {
                    path = default_path;
                }

                if (path) {

                    if (path.action !== 'wait' && previous.collect && previous.collect.multiple) {
                        // TODO: remove the final line of input
                        // since this would represent the "end" message and probably not part of the input
                    }

                    var res = await this.handleAction(path, dc, step);
                    if (res !== false) {
                        return res;
                    }
                }
            }
        }

        // If a prompt is defined in the script, use dc.prompt to call it.
        // This prompt must be a valid dialog defined somewhere in your code!
        if (line.collect) {
            try {
                return await dc.prompt(this._prompt, this.makeOutgoing(line, step.values));
            } catch (err) {
                console.error(err);
                const res = await dc.context.sendActivity(`Failed to start prompt ${ line.prompt.id }`);
                return await step.next();
            }
        // If there's nothing but text, send it!
        // This could be extended to include cards and other activity attributes.
        } else {
            // if there is text, attachments, or any channel data fields at all...
            if (line.text || line.attachments || Object.keys(line.channelData).length) {
                await dc.context.sendActivity(this.makeOutgoing(line, step.values)); 
            }

            if (line.action) {

                var res = await this.handleAction(line, dc, step);
                if (res !== false) {
                    return res;
                }
            }

            return await step.next();
        }
    }

    async runStep(dc, index, thread_name, reason, result?) {

        const thread = this.script[thread_name];

        if (index < thread.length) {
            // Update the step index
            const state = dc.activeDialog.state;
            state.stepIndex = index;
            const previous_thread = state.thread;
            state.thread = thread_name;

            // Create step context
            const nextCalled = false;
            const step = {
                index: index,
                thread: thread_name,
                state: state,
                options: state.options,
                reason: reason,
                result: result,
                values: state.values,
                next: async (stepResult) => {
                    if (nextCalled) {
                        throw new Error(`ScriptedStepContext.next(): method already called for dialog and step '${ this.id }[${ index }]'.`);
                    }

                    return await this.resumeDialog(dc, DialogReason.nextCalled, stepResult);
                }
            };

            // did we just start a new thread?
            // if so, run the before stuff.
            if (index === 0 && previous_thread != thread_name) {
                await this.runBefore(step.thread, dc, step);

                // did we just change threads? if so, restart
                if (index != step.index || thread_name != step.thread) {
                    return await this.runStep(dc, step.index, step.thread, DialogReason.nextCalled, step.values);
                }
            }

            // Execute step
            const res = await this.onStep(dc, step);

            return res;
        } else {

            // End of script so just return to parent
            return await this.end(dc, result);
        }
    }

    async end(dc: DialogContext, value: any) {

        // TODO: may have to move these around
        // shallow copy todo: may need deep copy
        const result = {
            ...dc.activeDialog.state.values
        };

        await dc.endDialog(value);
        await this.runAfter(dc, result);
        return DialogTurnStatus.complete;

    }

    async endDialog(context: TurnContext, instance: DialogInstance, reason: DialogReason) {
        // noop
    }

    private makeOutgoing(line, vars) {
        let outgoing;

        if (line.quick_replies) {
            outgoing = MessageFactory.suggestedActions(line.quick_replies.map((reply) => { return { type:  ActionTypes.PostBack, title: reply.title, text: reply.payload, displayText: reply.title, value: reply.payload}; }), line.text ? line.text[0] : '');
        } else {
            outgoing = MessageFactory.text(line.text ? line.text[Math.floor(Math.random()*line.text.length)] : '');
        }

        if (!outgoing.channelData) {
            outgoing.channelData = {};
        }

        // copy all the values in channelData fields
        for (var key in line.channelData) {
            outgoing.channelData[key] = line.channelData[key];
        }

        // Handle template token replacements
        if (outgoing.text) {
            outgoing.text = mustache.render(outgoing.text, {vars: vars});
        }

        // process templates in native botframework attachments
        if (outgoing.attachments) {
            outgoing.attachments = this.parseTemplatesRecursive(outgoing.attachments, vars);
        }

        // process templates in slack attachments
        if (outgoing.channelData.attachments) {
            outgoing.channelData.attachments = this.parseTemplatesRecursive(outgoing.channelData.attachments, vars);
        }

        // process templates in facebook attachments
        if (outgoing.channelData.attachment) {
            outgoing.channelData.attachment = this.parseTemplatesRecursive(outgoing.channelData.attachment, vars);
        }

        return outgoing;
    }


    private parseTemplatesRecursive(attachments, vars) {

        if (attachments && attachments.length) {
            for (let a = 0; a < attachments.length; a++) {
                for (let key in attachments[a]) {
                    if (typeof(attachments[a][key]) === 'string') {
                        attachments[a][key] =  mustache.render(attachments[a][key], {vars: vars});
                    } else {
                        attachments[a][key] = this.parseTemplatesRecursive(attachments[a][key], vars);
                    }
                }
            }
        } else {
            for (let x in attachments) {
                if (typeof(attachments[x]) === 'string') {
                    attachments[x] = mustache.render(attachments[x], {vars: vars});
                } else {
                    attachments[x] = this.parseTemplatesRecursive(attachments[x], vars);
                }
            }
        }


        return attachments;
    }

    public async gotoThread(thread, dc, step) {
        step.thread = thread;
        step.index = 0;
    }

    private async gotoThreadAction(thread, dc, step) {
        await this.gotoThread(thread, dc, step);
        // await this.runBefore(step.thread, dc, step);
        return await this.runStep(dc, step.index, step.thread, DialogReason.nextCalled, step.values);
    }

    private async handleAction(path, dc, step) {

        if (path.handler) {
            const index = step.index;
            const thread_name = step.thread;

            // spawn a bot instance so devs can use API or other stuff as necessary
            const bot = await this._controller.spawn(dc);

            // create a convo controller object
            const convo = new BotkitDialogWrapper(dc, step);   

            await path.handler.call(this, step.result, convo, bot);

            // did we just change threads? if so, restart this turn
            if (index != step.index || thread_name != step.thread) {
                return await this.runStep(dc, step.index, step.thread, DialogReason.nextCalled, step.values);
            }
            
            return false;
        }

        switch (path.action) {
            case 'next':
                break;
            case 'complete':
                step.values._status = 'completed';
                return await this.end(dc, step.result);
                break;
            case 'stop':
                step.values._status = 'canceled';
                return await this.end(dc, step.result);
                break;
            case 'timeout':
                step.values._status = 'timeout';
                return await this.end(dc, step.result);
                break;
            case 'execute_script':
                return await dc.replaceDialog(path.execute.script, {
                    thread: path.execute.thread,
                    ...step.values
                });
                break;
            case 'repeat':
                return await this.runStep(dc, step.index - 1, step.thread, DialogReason.nextCalled);
                break;
            case 'wait':
                // reset the state so we're still on this step.
                step.state.stepIndex = step.index - 1;
                // send a waiting status
                return { status: DialogTurnStatus.waiting };
                break;
            default:
                // the default behavior for unknown action in botkit is to gotothread
                if (this.script[path.action]) {
                    return await this.gotoThreadAction(path.action, dc, step);
                } else {
                    // TODO
                    console.log('NOT SURE WHAT TO DO WITH THIS!!', path);
                    break;
                }
        }

        return false;
    }
}

