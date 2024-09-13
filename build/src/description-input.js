"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@inquirer/core");
exports.default = (0, core_1.createPrompt)((config, done) => {
    const { required, validate = () => true } = config;
    const theme = (0, core_1.makeTheme)(config.theme);
    const [status, setStatus] = (0, core_1.useState)('pending');
    const [defaultValue = '', setDefaultValue] = (0, core_1.useState)(config.default);
    const [errorMsg, setError] = (0, core_1.useState)();
    const [value, setValue] = (0, core_1.useState)('');
    const isLoading = status === 'loading';
    const prefix = (0, core_1.usePrefix)({ isLoading, theme });
    (0, core_1.useKeypress)(async (key, rl) => {
        if (status !== 'pending') {
            return;
        }
        if ((0, core_1.isEnterKey)(key)) {
            const answer = value || defaultValue;
            setStatus('loading');
            const isValid = required && !answer ? 'You must provide a value' : await validate(answer);
            if (isValid === true) {
                setValue(answer);
                setStatus('done');
                done(answer);
            }
            else {
                rl.write(value);
                setError(isValid || 'You must provide a valid value');
                setStatus('pending');
            }
        }
        else if ((0, core_1.isBackspaceKey)(key) && !value) {
            setDefaultValue(undefined);
        }
        else if (key.name === 'tab' && !value) {
            setDefaultValue(undefined);
            rl.clearLine(0);
            rl.write(defaultValue);
            setValue(defaultValue);
        }
        else {
            setValue(rl.line);
            setError(undefined);
        }
    });
    const message = theme.style.message(config.message);
    let formattedValue = value;
    if (typeof config.transformer === 'function') {
        formattedValue = config.transformer(value, { isFinal: status === 'done' });
    }
    else if (status === 'done') {
        formattedValue = theme.style.answer(value);
    }
    let defaultStr;
    if (defaultValue && status !== 'done' && !value) {
        defaultStr = theme.style.defaultAnswer(defaultValue);
    }
    let error = '';
    if (errorMsg) {
        error = theme.style.error(errorMsg);
    }
    const description = theme.style.help(config.description);
    return [
        [prefix, message, defaultStr, formattedValue].filter((v) => v !== undefined).join(' '),
        errorMsg ? error : description,
    ];
});
//# sourceMappingURL=description-input.js.map