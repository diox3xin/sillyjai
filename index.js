/*
 * Card Tools - SillyTavern extension
 * Tools: translate World Info trigger keys, and preview/apply name replacement
 * in the current character card. No external sites, no popups.
 */

'use strict';

console.log('[CardTools] loaded v2.0.0');

(function () {
    function ctx() {
        return window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
    }

    function toast(message, type, ms) {
        type = type || 'info';
        const api = window.toastr || (ctx() && ctx().toastr);
        if (api && typeof api[type] === 'function') {
            api[type](message, 'Card Tools', { timeOut: ms || 4000 });
            return;
        }
        console[type === 'error' ? 'error' : 'log']('[CardTools]', message);
    }

    function h(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function makeButton(text, kind) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ct-btn ct-btn--' + (kind || 'secondary');
        button.textContent = text;
        return button;
    }

    function makeInput(value, placeholder) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ct-input';
        input.value = value || '';
        input.placeholder = placeholder || '';
        return input;
    }

    function makeCheckbox(checked) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'ct-checkbox';
        input.checked = !!checked;
        return input;
    }

    function makeSelect(options, selected) {
        const select = document.createElement('select');
        select.className = 'ct-select';
        options.forEach(function (item) {
            const option = document.createElement('option');
            option.value = item[0];
            option.textContent = item[1];
            if (String(item[0]) === String(selected)) option.selected = true;
            select.appendChild(option);
        });
        return select;
    }

    function row(label, control) {
        const wrap = document.createElement('label');
        wrap.className = 'ct-row';
        const text = document.createElement('span');
        text.className = 'ct-row-label';
        text.textContent = label;
        control.classList.add('ct-row-control');
        wrap.appendChild(text);
        wrap.appendChild(control);
        return wrap;
    }

    function checkRow(label, control) {
        const wrap = document.createElement('label');
        wrap.className = 'ct-check-row';
        wrap.appendChild(control);
        const text = document.createElement('span');
        text.textContent = label;
        wrap.appendChild(text);
        return wrap;
    }

    function modal(title) {
        const overlay = document.createElement('div');
        overlay.className = 'ct-overlay';
        const body = document.createElement('div');
        body.className = 'ct-modal';
        const head = document.createElement('div');
        head.className = 'ct-modal-head';
        head.textContent = title;
        body.appendChild(head);
        overlay.appendChild(body);
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
        return { overlay: overlay, body: body };
    }

    function logBox() {
        const wrap = document.createElement('div');
        wrap.className = 'ct-log';
        wrap.log = function (message) {
            const line = document.createElement('div');
            line.textContent = message;
            wrap.appendChild(line);
            wrap.scrollTop = wrap.scrollHeight;
        };
        return wrap;
    }

    function stripFences(text) {
        let value = String(text || '').trim();
        const fence = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (fence) value = fence[1].trim();
        const first = value.search(/[\[{]/);
        const last = Math.max(value.lastIndexOf('}'), value.lastIndexOf(']'));
        if (first >= 0 && last > first) value = value.slice(first, last + 1);
        return value;
    }

    function stApiConfig() {
        const context = ctx();
        let baseUrl = '';
        let apiKey = '';
        let model = '';
        try { baseUrl = (context && context.getApiUrl && context.getApiUrl()) || ''; } catch (_) { }
        try { apiKey = (context && context.getApiKey && context.getApiKey()) || ''; } catch (_) { }
        try { model = (context && context.getModel && context.getModel()) || ''; } catch (_) { }
        try { baseUrl = baseUrl || localStorage.getItem('ApiUrl') || localStorage.getItem('apiUrl') || ''; } catch (_) { }
        try { apiKey = apiKey || localStorage.getItem('ApiKey') || localStorage.getItem('apiKey') || ''; } catch (_) { }
        try { model = model || localStorage.getItem('Model') || localStorage.getItem('model') || ''; } catch (_) { }
        return { baseUrl: String(baseUrl || '').replace(/\/+$/, ''), apiKey: apiKey || '', model: model || '' };
    }

    function chatCompletion(messages) {
        const cfg = stApiConfig();
        if (!cfg.baseUrl || !cfg.model) {
            return Promise.reject(new Error('ST API не настроен. Подключи модель в API Connections.'));
        }
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, 180000);
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers.Authorization = 'Bearer ' + String(cfg.apiKey).replace(/^Bearer\s+/i, '');
        return fetch(cfg.baseUrl + '/v1/chat/completions', {
            method: 'POST',
            headers: headers,
            signal: controller.signal,
            body: JSON.stringify({
                model: cfg.model,
                temperature: 0.2,
                response_format: { type: 'json_object' },
                messages: messages,
            }),
        }).then(function (response) {
            if (!response.ok) {
                return response.text().then(function (text) {
                    throw new Error('LLM HTTP ' + response.status + ': ' + text.slice(0, 300));
                });
            }
            return response.json();
        }).then(function (data) {
            clearTimeout(timer);
            const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (!content) throw new Error('LLM вернул пустой ответ.');
            return content;
        }).catch(function (error) {
            clearTimeout(timer);
            throw error;
        });
    }

    function worldInfoNames() {
        const context = ctx();
        if (context && Array.isArray(context.worldInfoNames)) return context.worldInfoNames.slice();
        try {
            const raw = localStorage.getItem('worldInfo');
            return raw ? Object.keys(JSON.parse(raw)) : [];
        } catch (_) {
            return [];
        }
    }

    function currentWorldInfoName() {
        const context = ctx();
        try {
            const name = context && context.chat && context.chat.metadata && context.chat.metadata.world_info;
            if (typeof name === 'string' && name) return name;
        } catch (_) { }
        try {
            const name = context && context.characterData && context.characterData.data && context.characterData.data.extensions && context.characterData.data.extensions.world;
            if (typeof name === 'string' && name) return name;
        } catch (_) { }
        return '';
    }

    function loadWorldInfo(name) {
        const context = ctx();
        try {
            if (context && typeof context.loadWorldInfo === 'function') return Promise.resolve(context.loadWorldInfo(name));
        } catch (_) { }
        try {
            const raw = localStorage.getItem('worldInfo');
            const data = raw ? JSON.parse(raw) : {};
            return Promise.resolve(data[name] || null);
        } catch (_) {
            return Promise.resolve(null);
        }
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 0);
    }

    function saveWorldInfo(name, data) {
        const context = ctx();
        try {
            if (context && typeof context.saveWorldInfo === 'function') {
                return Promise.resolve(context.saveWorldInfo(name, data, true)).then(function () { return { ok: true }; });
            }
        } catch (_) { }
        const form = new FormData();
        form.append('name', name);
        form.append('file', new File([JSON.stringify(data)], name + '.json', { type: 'application/json' }));
        return fetch('/api/worldinfo/import', { method: 'POST', body: form }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return { ok: true };
        }).catch(function () {
            downloadJson(data, name + '.json');
            return { ok: false, fallback: true };
        });
    }

    const TRANSLATE_PROMPT = 'Translate roleplay lorebook trigger keys into the target language. Output ONLY JSON: {"translations":["..."]}. The output array must have the same length and order as the input array. Keep proper names as accepted transliterations. For Russian use nominative singular. No markdown.';

    function translateBatch(keys, language, logger) {
        if (!keys.length) return Promise.resolve([]);
        logger('Перевожу ' + keys.length + ' ключей -> ' + language);
        return chatCompletion([
            { role: 'system', content: TRANSLATE_PROMPT },
            { role: 'user', content: 'Target language: ' + language + '\nKeys JSON array:\n' + JSON.stringify(keys) },
        ]).then(function (reply) {
            let parsed;
            try { parsed = JSON.parse(stripFences(reply)); }
            catch (_) { throw new Error('LLM не вернул валидный JSON переводов.'); }
            const result = parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
            if (result.length !== keys.length) throw new Error('LLM вернул ' + result.length + ' переводов на ' + keys.length + ' ключей.');
            return result.map(function (value, index) { return String(value || '').trim() || keys[index]; });
        });
    }

    function translateWorldInfoKeys(worldInfo, language, logger) {
        const keys = [];
        const seen = new Set();
        Object.values((worldInfo && worldInfo.entries) || {}).forEach(function (entry) {
            ['key', 'keysecondary'].forEach(function (field) {
                (Array.isArray(entry[field]) ? entry[field] : []).forEach(function (key) {
                    const value = String(key || '').trim();
                    if (!value || seen.has(value)) return;
                    seen.add(value);
                    keys.push(value);
                });
            });
        });
        if (!keys.length) return Promise.resolve(worldInfo);

        const map = new Map();
        let chain = Promise.resolve();
        for (let i = 0; i < keys.length; i += 40) {
            const batch = keys.slice(i, i + 40);
            chain = chain.then(function () {
                return translateBatch(batch, language, logger).then(function (translated) {
                    translated.forEach(function (value, index) { map.set(batch[index], value); });
                });
            });
        }
        return chain.then(function () {
            const copy = clone(worldInfo);
            Object.values(copy.entries || {}).forEach(function (entry) {
                ['key', 'keysecondary'].forEach(function (field) {
                    const values = Array.isArray(entry[field]) ? entry[field] : [];
                    const local = new Set();
                    entry[field] = values.map(function (value) { return String(map.get(value) || value).trim(); })
                        .filter(function (value) {
                            const marker = value.toLowerCase();
                            if (!value || local.has(marker)) return false;
                            local.add(marker);
                            return true;
                        });
                });
            });
            return copy;
        });
    }

    function buildTranslateModal() {
        const names = worldInfoNames();
        const current = currentWorldInfoName();
        const wiSelect = makeSelect([['__current__', current ? 'Current: ' + current : 'Current bound lorebook']].concat(names.map(function (name) { return [name, name]; })), '__current__');
        const langSelect = makeSelect([
            ['ru-RU', 'Russian'], ['uk-UA', 'Ukrainian'], ['en-US', 'English'],
            ['es-ES', 'Spanish'], ['zh-CN', 'Chinese'], ['ja-JP', 'Japanese'], ['__other__', 'Other...'],
        ], 'ru-RU');
        const customLang = makeInput('', 'Language code/name');
        customLang.style.display = 'none';
        langSelect.addEventListener('change', function () { customLang.style.display = langSelect.value === '__other__' ? '' : 'none'; });

        const box = modal('Translate World Info keys');
        const log = logBox();
        const cancel = makeButton('Cancel', 'secondary');
        const run = makeButton('Translate', 'primary');
        box.body.appendChild(row('World Info', wiSelect));
        box.body.appendChild(row('Target language', langSelect));
        box.body.appendChild(row('Custom language', customLang));
        box.body.appendChild(log);
        const actions = document.createElement('div');
        actions.className = 'ct-modal-buttons';
        actions.appendChild(cancel);
        actions.appendChild(run);
        box.body.appendChild(actions);
        cancel.addEventListener('click', function () { box.overlay.remove(); });
        run.addEventListener('click', function () {
            const language = langSelect.value === '__other__' ? customLang.value.trim() : langSelect.value;
            const name = wiSelect.value === '__current__' ? currentWorldInfoName() : wiSelect.value;
            if (!language) return toast('Укажи язык.', 'error');
            if (!name) return toast('Выбери лорбук.', 'error');
            run.disabled = true;
            cancel.disabled = true;
            log.log('Загружаю лорбук: ' + name);
            loadWorldInfo(name).then(function (worldInfo) {
                if (!worldInfo || !worldInfo.entries) throw new Error('Не удалось загрузить лорбук: ' + name);
                return translateWorldInfoKeys(worldInfo, language, log.log).then(function (translated) {
                    log.log('Сохраняю лорбук...');
                    return saveWorldInfo(name, translated);
                });
            }).then(function (result) {
                log.log('Готово.');
                toast(result && result.fallback ? 'Файл лорбука скачан, сохранение через API не сработало.' : 'Ключи переведены.', result && result.fallback ? 'warning' : 'success', 6000);
            }).catch(function (error) {
                log.log('Ошибка: ' + (error.message || error));
                toast(error.message || String(error), 'error', 7000);
            }).then(function () {
                run.disabled = false;
                cancel.disabled = false;
            });
        });
    }

    const CARD_FIELDS = [
        ['name', 'Name'], ['description', 'Description'], ['personality', 'Personality'],
        ['scenario', 'Scenario'], ['first_mes', 'First message'], ['mes_example', 'Example messages'],
        ['creator_notes', 'Creator notes'], ['creatorcomment', 'Creator comment'],
        ['system_prompt', 'System prompt'], ['post_history_instructions', 'Post-history instructions'],
    ];

    function currentCharacter() {
        const context = ctx();
        if (!context || context.characterId == null) return null;
        return context.characters && context.characters[context.characterId] ? context.characters[context.characterId] : null;
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceText(text, pairs, options) {
        let value = String(text == null ? '' : text);
        let count = 0;
        pairs.forEach(function (pair) {
            const escaped = escapeRegExp(pair.find);
            const source = options.wholeWords ? '(^|[^\\p{L}\\p{N}_])(' + escaped + ')(?=$|[^\\p{L}\\p{N}_])' : '(' + escaped + ')';
            const regex = new RegExp(source, options.caseSensitive ? 'gu' : 'giu');
            value = value.replace(regex, function () {
                count++;
                return options.wholeWords ? arguments[1] + pair.replace : pair.replace;
            });
        });
        return { value: value, count: count };
    }

    function previewRename(character, pairs, options) {
        const data = character && character.data ? character.data : character;
        const summary = [];
        let total = 0;
        CARD_FIELDS.forEach(function (field) {
            if (typeof data[field[0]] !== 'string') return;
            const result = replaceText(data[field[0]], pairs, options);
            if (result.count) {
                summary.push({ label: field[1], count: result.count });
                total += result.count;
            }
        });
        (Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []).forEach(function (text, index) {
            const result = replaceText(text, pairs, options);
            if (result.count) {
                summary.push({ label: 'Alt greeting #' + (index + 1), count: result.count });
                total += result.count;
            }
        });
        return { total: total, summary: summary };
    }

    function applyRename(character, pairs, options) {
        const copy = clone(character);
        const data = copy.data || copy;
        CARD_FIELDS.forEach(function (field) {
            if (typeof data[field[0]] === 'string') data[field[0]] = replaceText(data[field[0]], pairs, options).value;
        });
        if (Array.isArray(data.alternate_greetings)) {
            data.alternate_greetings = data.alternate_greetings.map(function (text) { return replaceText(text, pairs, options).value; });
        }
        if (copy.data && typeof data.name === 'string') copy.name = data.name;
        return copy;
    }

    function saveCurrentCharacter(character) {
        const context = ctx();
        if (context && context.characters && context.characterId != null) context.characters[context.characterId] = character;
        const headers = { 'Content-Type': 'application/json' };
        try { if (window.getRequestHeaders) Object.assign(headers, window.getRequestHeaders()); } catch (_) { }
        return fetch('/api/characters/edit', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(character),
        }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return { ok: true };
        }).catch(function () {
            downloadJson(character, (character.name || 'character') + '-edited.json');
            return { ok: false, fallback: true };
        });
    }

    function buildRenameModal() {
        const character = currentCharacter();
        if (!character) return toast('Открой персонажа, в котором нужно заменить имя.', 'error', 5000);
        const box = modal('Rename in current character card');
        const note = document.createElement('div');
        note.className = 'ct-note';
        note.textContent = 'Current character: ' + ((character.data && character.data.name) || character.name || 'Unnamed');
        box.body.appendChild(note);

        const pairsBox = document.createElement('div');
        pairsBox.className = 'ct-pairs';
        function addPair(find, replace) {
            const pair = document.createElement('div');
            pair.className = 'ct-pair';
            const findInput = makeInput(find || '', 'Find');
            const replaceInput = makeInput(replace || '', 'Replace with');
            const remove = makeButton('Remove', 'secondary');
            pair.appendChild(findInput);
            pair.appendChild(replaceInput);
            pair.appendChild(remove);
            pairsBox.appendChild(pair);
            remove.addEventListener('click', function () { pair.remove(); });
        }
        addPair('', '');
        box.body.appendChild(pairsBox);
        const add = makeButton('Add pair', 'secondary');
        box.body.appendChild(add);
        const wholeWords = makeCheckbox(true);
        const caseSensitive = makeCheckbox(false);
        box.body.appendChild(checkRow('Whole words only', wholeWords));
        box.body.appendChild(checkRow('Case sensitive', caseSensitive));
        const previewBox = document.createElement('div');
        previewBox.className = 'ct-preview';
        box.body.appendChild(previewBox);

        const cancel = makeButton('Cancel', 'secondary');
        const preview = makeButton('Preview', 'secondary');
        const apply = makeButton('Apply', 'primary');
        apply.disabled = true;
        const actions = document.createElement('div');
        actions.className = 'ct-modal-buttons';
        actions.appendChild(cancel);
        actions.appendChild(preview);
        actions.appendChild(apply);
        box.body.appendChild(actions);

        let lastPairs = [];
        let lastOptions = null;
        function collectPairs() {
            const pairs = [];
            pairsBox.querySelectorAll('.ct-pair').forEach(function (node) {
                const inputs = node.querySelectorAll('input[type="text"]');
                const find = inputs[0] ? inputs[0].value.trim() : '';
                const replace = inputs[1] ? inputs[1].value : '';
                if (find) pairs.push({ find: find, replace: replace });
            });
            return pairs;
        }
        function render(result) {
            if (!result.total) {
                previewBox.innerHTML = '<div class="ct-warning">Совпадений не найдено.</div>';
                return;
            }
            previewBox.innerHTML = '<div class="ct-preview-title">Всего замен: ' + result.total + '</div><ul>' +
                result.summary.map(function (item) { return '<li>' + h(item.label) + ': ' + item.count + '</li>'; }).join('') + '</ul>';
        }
        add.addEventListener('click', function () { addPair('', ''); });
        cancel.addEventListener('click', function () { box.overlay.remove(); });
        preview.addEventListener('click', function () {
            lastPairs = collectPairs();
            if (!lastPairs.length) return toast('Добавь хотя бы одну пару поиска/замены.', 'error');
            lastOptions = { wholeWords: wholeWords.checked, caseSensitive: caseSensitive.checked };
            const result = previewRename(currentCharacter(), lastPairs, lastOptions);
            render(result);
            apply.disabled = !result.total;
        });
        apply.addEventListener('click', function () {
            const updated = applyRename(currentCharacter(), lastPairs, lastOptions);
            apply.disabled = true;
            preview.disabled = true;
            saveCurrentCharacter(updated).then(function (result) {
                toast(result && result.fallback ? 'Сохранение через API не сработало, JSON скачан.' : 'Карточка обновлена.', result && result.fallback ? 'warning' : 'success', 6000);
                box.overlay.remove();
            }).catch(function (error) {
                toast(error.message || String(error), 'error', 7000);
            }).then(function () {
                apply.disabled = false;
                preview.disabled = false;
            });
        });
    }

    function installUi() {
        const container = document.getElementById('extensions_settings');
        if (!container) return false;
        if (document.getElementById('ct_settings_root')) return true;
        container.insertAdjacentHTML('beforeend',
            '<div class="ct-settings" id="ct_settings_root">' +
            '<div class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header"><b>Card Tools</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '<div class="inline-drawer-content"><div class="ct-settings-actions">' +
            '<div class="menu_button" id="ct_open_translate"><i class="fa-solid fa-language"></i> Translate keys</div>' +
            '<div class="menu_button" id="ct_open_rename"><i class="fa-solid fa-pen-to-square"></i> Rename in card</div>' +
            '</div></div></div></div>');
        document.getElementById('ct_open_translate').addEventListener('click', buildTranslateModal);
        document.getElementById('ct_open_rename').addEventListener('click', buildRenameModal);
        return true;
    }

    function init() {
        installUi();
        let tries = 0;
        const timer = setInterval(function () {
            tries++;
            if (document.getElementById('ct_settings_root') || tries > 40) return clearInterval(timer);
            installUi();
        }, 500);
    }

    try {
        const context = ctx();
        if (context && context.eventSource && context.event_types && context.event_types.APP_READY) {
            context.eventSource.on(context.event_types.APP_READY, init);
        }
    } catch (_) { }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();