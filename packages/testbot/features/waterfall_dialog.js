/* This is a sample feature module that uses Bot Builder Waterfall dialogs */

const { WaterfallDialog, TextPrompt } = require('botbuilder-dialogs');

const DIALOG_ID = 'waterfall_sample';
const PROMPT_ID = 'waterfall_prompt';
const sample_waterfall = new WaterfallDialog(DIALOG_ID, [

    async (step) => {
        await step.context.sendActivity('This is the first step of a waterfall dialog');
        return await step.next();
    },
    async (step) => {
        return await step.prompt(PROMPT_ID,'Say something! I will receive your input.');
    },
    async (step) => {
        const result = step.result;
        await step.context.sendActivity('You said ' + result);
        return await step.next();
    },
    async (step) => {
        await step.context.sendActivity('Done');
        return await step.next();
    }
]);

module.exports = function(controller) {

    controller.dialogSet.add(new TextPrompt(PROMPT_ID));
    controller.dialogSet.add(sample_waterfall);

    controller.hears(['waterfall'], 'message', async(bot, message) => {
        await bot.beginDialog(DIALOG_ID);
    });

}