// ==UserScript==
// @name         Tanoth Bot With UI
// @namespace    https://github.com/st0rmr3v3ng3/AutomaTanoth/
// @version      0.91
// @description  Tanoth automation bot with UI controls
// @match        https://*.tanoth.gameforge.com/main/client/*
// @grant        none
// @run-at       document-idle
// @author      -
// @description 30/01/2026, 23:16:15
// ==/UserScript==

(function () {
    'use strict';
//Main Bot logic

/*********************************************************
* Config
*********************************************************/

const CONSTANTS = {
  DIFFICULTY_MAP: {
    easy: -1,
    medium: 0,
    difficult: 1,
    very_difficult: 2,
  },
  ATTRIBUTE_KEYS: ['STR', 'DEX', 'CON', 'INT'],
  ATTRIBUTE_FALLBACK_VAL: 999999, // High default to prevent bad upgrades
  CIRCLE_NODES: {
	  	/*
		8 = Jade
		1 = Amethyst
		
		2 = Bernstein ?
		3 = Topas ?
		4 = Rubin ?
		5 = Smaragd ?
		6 = Saphir ?
		7 = Aquamarin ?
		.
		9 = Tigerauge ?
		10 = Diamant ?
		
		11 = Rune des Mutes ?
		12 = Rune des Eifers ?
		13 = Rune der Weisheit ?
		14 = Rune der Verhandlung ?
		15 =  Rune des Ruhmes ?
		
		16 = Schädel
		*/
    BASE: 16,
    HIGH_PRIORITY: [8, 1],
    GROUPS: [
      [15, 9, 10],
      [11, 1, 2],
      [12, 3, 4],
      [13, 5, 6],
      [14, 7, 8],
    ],
  },
  CIRCLE_COST_FORMULAS: { // Values as i have gathered on my server, scaled by 3/5ths
    base: level => level * 1500 + 3000,
    secondary: level => level * 3 + 6,
    tertiary: level => level * 30 + 60,
  },
  RPC_RETRY: { attempts: 3, delay: 2000 },
  CACHE_TTL: 30000,  // 30s resource cache
  NO_ADVENTURES_WAIT_SEC: 1200, // 20 min wait time if no adventures found 
};

/*********************************************************
* Helpers
*********************************************************/

const TimingService = (() => {
  const sleep = seconds => new Promise(r => setTimeout(r, seconds * 1000));

  async function retry(fn, attempts = 3, delay = 2) {
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === attempts - 1) throw e;
         await sleep(delay);
      }
    }
  }

  return { sleep, retry };
})();

const Logger = {
  log: (...a) => console.log('[Bot]', ...a),
  warn: (...a) => console.warn('[Bot]', ...a),
  error: (...a) => console.error('[Bot]', ...a),
};

const botState = {
  config: {
	url: location.href.replace('/main/client', '/xmlrpc'),
    serverSpeed: 2,
    priorityAdventure: 'gold',
    difficulty: 'difficult',
    spendGoldOn: 'circle',
    priorityAttribute: 'MIX',
    minGoldToKeep: 0,
    // useBloodstones: false,        // TODO: bloodstones currently unused
    // minBloodstonesToKeep: 0,
  },
  resources: { gold: 0, bloodstones: 0 },
  abortSignal: null,  // AbortController.signal
  isRunning: false,
  lastResourcesFetch: 0,  // Timestamp for caching
};

/*********************************************************
* Infrastructure
*********************************************************/

const XmlRpcClient = {
  async call(method, paramsXml, signal = null) {
    const xml = `<methodCall><methodName>${method}</methodName><params>${paramsXml}</params></methodCall>`;
	
    const attempt = async () => {
      const response = await fetch(botState.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml,
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    };

    for (let i = 0; i < CONSTANTS.RPC_RETRY.attempts; i++) {
      try {
        return await attempt();
      } catch (err) {
      if (i === CONSTANTS.RPC_RETRY.attempts - 1) {
        Logger.error('RPC failed', method, err);
        throw err;
      }
      await TimingService.sleep(CONSTANTS.RPC_RETRY.delay / 1000);
      }
    }
  },
};

const XmlParsers = {
  findValue(struct, name, type = 'i4') {
    const member = [...(struct?.getElementsByTagName('member') || [])].find(
      m => m.querySelector('name')?.textContent === name
    );
    return member?.querySelector(type)?.textContent ?? null;
  },

  safeParseInt(value, defaultValue = 0) {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  },

  parseResources(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const struct = doc.querySelector('struct');
      if (!struct) throw new Error('No struct found in resources XML');

      return {
        gold: this.safeParseInt(this.findValue(struct, 'gold')),
        bloodstones: this.safeParseInt(this.findValue(struct, 'bs')),
      };
    } catch (err) {
      Logger.error('Failed to parse resources', err);
      return { gold: 0, bloodstones: 0 };
    }
  },

  parseAdventures(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');

      // Parse adventure list
      const adventureElements = doc.querySelectorAll('array > data > value > struct');
      const adventures = Array.from(adventureElements).map(el => ({
        difficulty: this.safeParseInt(this.findValue(el, 'difficulty', 'i4')),
        gold: this.safeParseInt(this.findValue(el, 'gold', 'i4')),
        experience: this.safeParseInt(this.findValue(el, 'exp', 'i4')),
        duration: this.safeParseInt(this.findValue(el, 'duration', 'i4')),
        id: this.safeParseInt(this.findValue(el, 'quest_id', 'i4')),
      })).filter(a => a.id > 0); // Filter invalid entries

      // Parse daily counters (fallback to 0 if missing)
      const struct = doc.querySelector('struct');
      const adventuresMadeToday = this.safeParseInt(this.findValue(struct, 'adventures_made_today'));
      const freeAdventuresPerDay = this.safeParseInt(this.findValue(struct, 'free_adventures_per_day'), 999); // Large default to avoid false "no more"

      return {
        adventures,
        adventuresMadeToday,
        freeAdventuresPerDay,
        hasRemainingAdventures: adventuresMadeToday < freeAdventuresPerDay,
        hasAnotherTaskRunning: isNaN(adventuresMadeToday) || adventuresMadeToday < 0,
        taskRunning: null, // TODO Why do i still have this? 
      };
    } catch (err) {
      Logger.error('Failed to parse adventures', err);
      return {
        adventures: [],
        adventuresMadeToday: 0,
        freeAdventuresPerDay: 0,
        hasRemainingAdventures: false,
        hasAnotherTaskRunning: true, // Fail-safe: assume busy
        taskRunning: null, // TODO Why do i still have this? 
      };
    }
  },

  parseTask(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const struct = doc.querySelector('struct');
      if (!struct) throw new Error('No struct in task XML');

      return {
        timeTask: this.safeParseInt(this.findValue(struct, 'time'), 0),
        typeTask: this.findValue(struct, 'type') ?? 'unknown',
      };
    } catch (err) {
      Logger.error('Failed to parse task', err);
      return { timeTask: 0, typeTask: 'unknown' };
    }
  },

  parseCircle(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const members = doc.getElementsByTagName('member');
      const result = {};

      for (const member of members) {
        const name = member.getElementsByTagName('name')[0]?.textContent;
        const valueString = member.getElementsByTagName('string')[0]?.textContent;

        if (name && valueString) {
          const attributes = valueString
            .split(':')
            .map(v => parseFloat(v.trim()))
            .filter(v => !isNaN(v));
          if (attributes.length > 0) {
            result[name] = attributes;
          }
        }
      }

      // Validate: ensure expected nodes exist (optional)
      if (!result[CONSTANTS.CIRCLE_NODES?.BASE ?? '16']) {
        Logger.warn('Base circle node missing in parsed data');
      }

      return result;
    } catch (err) {
      Logger.error('Failed to parse circle', err);
      return {};
    }
  },

  parseAttributes(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const struct = doc.querySelector('struct');
      if (!struct) throw new Error('No struct in attributes XML');

      const costs = {};
      CONSTANTS.ATTRIBUTE_KEYS.forEach(attr => {
        const key = `cost_${attr.toLowerCase()}`;
        costs[attr] = this.safeParseInt(this.findValue(struct, key), CONSTANTS.ATTRIBUTE_FALLBACK_VAL); 
      });

      return costs;
    } catch (err) {
      Logger.error('Failed to parse attributes', err);
      return { STR: CONSTANTS.ATTRIBUTE_FALLBACK_VAL, 
	  DEX: CONSTANTS.ATTRIBUTE_FALLBACK_VAL, 
	  CON: CONSTANTS.ATTRIBUTE_FALLBACK_VAL, 
	  INT: CONSTANTS.ATTRIBUTE_FALLBACK_VAL };
    }
  },
};

const ResourceRepository = {
  // force parameter added
  async get(force = false) {
    if (
      !force &&
      Date.now() - botState.lastResourcesFetch < CONSTANTS.CACHE_TTL
    ) {
      return botState.resources;
    }

    try {
      const xml = await XmlRpcClient.call(
        'MiniUpdate',
        `<param><value><string>${flashvars.sessionID}</string></value></param>`,
        botState.abortSignal
      );

      const parsed = XmlParsers.parseResources(xml);
      botState.resources = parsed;
      botState.lastResourcesFetch = Date.now();
	  Logger.log('Resources fetched', parsed);
      return parsed;
    } catch (err) {
      Logger.error('Failed to fetch resources', err);
      return botState.resources;
    }
  },
};

/*********************************************************
* Domain 
*********************************************************/

class Adventure {
  constructor(data) {
    Object.assign(this, data);
  }
  get value() {
    return botState.config.priorityAdventure === 'gold' ? this.gold : this.experience;
  }
}

class EvocationCircle {
  constructor(nodes) {
    this.nodes = nodes; // Map<id, [values...]>
  }

  getBestNodeToBuy() {
    if (!this.nodes[CONSTANTS.CIRCLE_NODES.BASE]) return null;
    const baseLevel = this.nodes[CONSTANTS.CIRCLE_NODES.BASE][0];
    if (baseLevel === 10) return null;

    const hundredLimit = (baseLevel + 1) * 100;
    const tenLimit = (baseLevel + 1) * 10;
    const value = id => this.nodes[id]?.[0] ?? 0;
	
    // High priority first
    for (const id of CONSTANTS.CIRCLE_NODES.HIGH_PRIORITY) {
      if (value(id) < hundredLimit) return id;
    }

    // Group logic
    for (const group of CONSTANTS.CIRCLE_NODES.GROUPS) {
      const [target, a, b] = group;
      if (
        value(target) < tenLimit &&
        (value(target) + 1) * 10 <= value(a) &&
        (value(target) + 1) * 10 <= value(b)
      ) return target;

      for (const id of group.slice(1)) {
        if (value(id) < hundredLimit) return id;
      }
    }

    return CONSTANTS.CIRCLE_NODES.BASE;
  }

  getCost(nodeId) {
    const level = this.nodes[nodeId]?.[11] ?? 0;
    if (nodeId === CONSTANTS.CIRCLE_NODES.BASE) return CONSTANTS.CIRCLE_COST_FORMULAS.base(level);
    if (nodeId <= 10) return CONSTANTS.CIRCLE_COST_FORMULAS.secondary(level);
    return CONSTANTS.CIRCLE_COST_FORMULAS.tertiary(level);
  }
}

//TODO: refactor Attributes (Map<string, cost>)

/*********************************************************
* Services
*********************************************************/

const CircleService = {
  async run() {
    while (!botState.abortSignal?.aborted) {
      const xml = await XmlRpcClient.call(
        'EvocationCircle_getCircle',
        `<param><value><string>${flashvars.sessionID}</string></value></param>`,
        botState.abortSignal
      );

      const circle = new EvocationCircle(XmlParsers.parseCircle(xml));
      const nodeId = circle.getBestNodeToBuy();
      if (!nodeId) break;

      const cost = circle.getCost(nodeId);
      const resources = await ResourceRepository.get(true); // ★ force fresh

      if (resources.gold - cost < botState.config.minGoldToKeep) break;
	  
	  Logger.log(`Upgrading circle node ${nodeId} (cost ${cost} gold)`);

      await XmlRpcClient.call(
        'EvocationCircle_buyNode',
        `
        <param><value><string>${flashvars.sessionID}</string></value></param>
        <param><value><string>gold</string></value></param>
        <param><value><int>${nodeId}</int></value></param>
        <param><value><int>1</int></value></param>
        `,
        botState.abortSignal
      );

      await ResourceRepository.get(true); // ★ refresh cache after spend
      await TimingService.sleep(0.5);
    }
  },
};

const AdventureService = {
  async list(signal = botState.abortSignal) {
    try {
      const xml = await XmlRpcClient.call('GetAdventures', `
        <param><value><string>${flashvars.sessionID}</string></value></param>
      `, signal);
      const raw = XmlParsers.parseAdventures(xml);
      return {
        ...raw,
        adventures: raw.adventures.map(data => new Adventure(data)),
      };
    } catch (err) {
      Logger.error('Failed to list adventures', err);
      return { adventures: [], hasRemainingAdventures: false, hasAnotherTaskRunning: true };
    }
  },

  filterByDifficulty(adventures, difficulty) {
    const max = CONSTANTS.DIFFICULTY_MAP[difficulty] ?? 1;
    return adventures.filter(a => a.difficulty <= max);
  },

  selectBest(adventures) {
    return adventures.reduce(
      (best, curr) => (curr.value > best.value ? curr : best),
      adventures[0]
    );
  },

  selectAdventure(data) {
    const filtered = this.filterByDifficulty(
      data.adventures,
      botState.config.difficulty
    );

    if (filtered.length === 0) {
      Logger.log('No adventures match difficulty');
      return null;
    }

    const best = this.selectBest(filtered);
    return best ?? filtered[Math.floor(Math.random() * filtered.length)];
  },

  async start(adventureId, signal = botState.abortSignal) {
    if (!adventureId) throw new Error('Invalid adventure ID');
    return XmlRpcClient.call('StartAdventure', `
      <param><value><string>${flashvars.sessionID}</string></value></param>
      <param><value><int>${adventureId}</int></value></param>
    `, signal);
  },
};

const AttributeService = {
  async getCosts(signal = botState.abortSignal) {
    const xml = await XmlRpcClient.call(
      'GetUserAttributes',
      `<param><value><string>${flashvars.sessionID}</string></value></param>`,
      signal
    );
    return XmlParsers.parseAttributes(xml);
  },

  getLowestCostAttr(costs) {
    return Object.entries(costs).reduce((min, curr) => 
      curr[1] < min[1] ? curr : min,
	  ['', Infinity]
	)[0];
  },

  async upgrade(attr, signal = botState.abortSignal) {
    if (!CONSTANTS.ATTRIBUTE_KEYS.includes(attr)) throw new Error(`Invalid attribute: ${attr}`);
    return XmlRpcClient.call(
      'RaiseAttribute',
      `
      <param><value><string>${flashvars.sessionID}</string></value></param>
      <param><value><string>${attr}</string></value></param>
      `,
      signal
    );
  },

  async run() {
    let costs = await this.getCosts();

    while (!botState.abortSignal?.aborted) {
      const attr =
        botState.config.priorityAttribute === 'MIX'
          ? this.getLowestCostAttr(costs)
          : botState.config.priorityAttribute;

      if (!attr) break;

      const resources = await ResourceRepository.get(true); // force fresh
      if (resources.gold < costs[attr]) break;
	  
	  Logger.log(`Upgrading attribute ${attr} (cost ${costs[attr]} gold)`);

      const xml = await this.upgrade(attr);
      costs = XmlParsers.parseAttributes(xml);

      await ResourceRepository.get(true); // refresh after spend
      await TimingService.sleep(0.5);
    }
  },
};

const TaskService = {
  async getRunningTask(signal = botState.abortSignal) {
    const xml = await XmlRpcClient.call('MiniUpdate', `
      <param><value><string>${flashvars.sessionID}</string></value></param>
    `, signal);
    return XmlParsers.parseTask(xml);
  },

  async wait(task) {
    const time =
      isNaN(task.timeTask) || task.timeTask <= 0
        ? 600
        : task.timeTask + 2;

    Logger.log(`Waiting for running task (${time}s)`);
    await TimingService.sleep(time);
  }
};

/* do not use - EconomyService is replaced by ResourceRepository (from previous refactor)
const EconomyService = {
  canSpendGold(cost) {
    return botState.resources.gold - cost >= botState.config.minGoldToKeep;
  },
  // getResources() → Use ResourceRepository.get() directly in calls
};
*/

/*********************************************************
* Bot Orchestrator (State Machine)
*********************************************************/
	
const BotOrchestrator = {
  async tick() {
    if (botState.abortSignal.aborted) return;

    // Spend gold first (high priority to prevent looting)
    if (botState.config.spendGoldOn === 'circle') {
      await CircleService.run();
    } else {
      await AttributeService.run();
    }

    const adventures = await AdventureService.list();
    if (adventures.hasAnotherTaskRunning) {
      const task = await TaskService.getRunningTask();
      await TaskService.wait(task);
      return;
    }

    if (!adventures.hasRemainingAdventures) {
      Logger.log('No adventures left today');
      await sleep(CONSTANTS.NO_ADVENTURES_WAIT_SEC);
      return;
    }

    const selected = AdventureService.selectAdventure(adventures);
    if (!selected) return;

    Logger.log('Starting adventure', selected);
    await AdventureService.start(selected.id);

    await TimingService.sleep(
      selected.duration / botState.config.serverSpeed + 5
    );
  },

  async run() {
    try {
      while (botState.isRunning && !botState.abortSignal?.aborted) {
        await this.tick();
      }
    } catch (err) {
      if (err.name !== 'AbortError') Logger.error('Bot crashed', err);
      botState.isRunning = false;
      updateToggleButton();
    }
  },
};

/*********************************************************
* Bot Control (Lifecycle & Abort)
*********************************************************/

let abortController = null;

function updateToggleButton() { 
  const btn = document.getElementById('bot-toggle');
  if (!btn) return;
  btn.textContent = botState.isRunning ? 'Stop Bot' : 'Start Bot';
  btn.className = botState.isRunning ? 'running' : 'stopped';
}

function stopBot() {
  botState.isRunning = false;
  abortController?.abort();
  updateToggleButton();
}

async function startBot() {
  if (botState.isRunning) return;
  botState.isRunning = true;
  abortController = new AbortController();
  botState.abortSignal = abortController.signal;
  updateToggleButton();
  await BotOrchestrator.run();
}

/*********************************************************
* UI 
*********************************************************/
function bindConfig(id, key, type = 'string') {
  const el = document.getElementById(id);
  el.value = botState.config[key];  // Initial
  el.addEventListener('change', () => {
    let val = el.value;
    if (type === 'number') val = Math.max(0, parseInt(val, 10) || 0);
    if (type === 'bool') val = el.checked;
    botState.config[key] = val;
    Logger.log(`Config updated: ${key} = ${val}`);
  });
}

function createBotUI() { // TODO maybe get rid of bloodstones option altogether?
  if (document.getElementById('bot-ui')) return;

  const ui = document.createElement('div');
  ui.id = 'bot-ui';
  ui.innerHTML = `
		<style>
			#bot-ui {
	  		position: fixed;
    		top: 10px;
				right: 10px;
				width: 280px;
				background: #111;
				color: #eee;
				font-family: Arial, sans-serif;
				font-size: 12px;
				border: 1px solid #444;
				border-radius: 6px;
				z-index: 999999;
			}
			#bot-ui header {
				padding: 6px;
				font-weight: bold;
				background: #222;
				border-bottom: 1px solid #333;
				text-align: center;
			}
			#bot-ui .body {
				padding: 8px;
			}
			#bot-ui label {
				display: block;
				margin-top: 6px;
			}
			#bot-ui input,
			#bot-ui select {
				width: 100%;
				margin-top: 2px;
			}
			#bot-ui button {
				width: 100%;
				margin-top: 8px;
				padding: 6px;
				cursor: pointer;
			}
			#bot-ui .running { background: #b33; }
			#bot-ui .stopped { background: #1b5; }
		</style>

    <header>Adventure Bot</header>
    <div class="body">
      <label>Server speed <input type="number" id="cfg-serverSpeed"></label>
      <label>Adventure priority <select id="cfg-priorityAdventure">
        <option value="gold">Gold</option>
        <option value="experience">Experience</option>
      </select></label>
      <label>Difficulty <select id="cfg-difficulty">
        <option value="easy">Easy</option>
        <option value="medium">Medium</option>
        <option value="difficult">Difficult</option>
        <option value="very_difficult">Very Difficult</option>
      </select></label>
      <label>Spend gold on <select id="cfg-spendGoldOn">
        <option value="circle">Circle</option>
        <option value="attributes">Attributes</option>
      </select></label>
      <label>Attribute priority <select id="cfg-priorityAttribute">
        <option value="MIX">MIX</option>
        <option value="STR">STR</option>
        <option value="DEX">DEX</option>
        <option value="CON">CON</option>
        <option value="INT">INT</option>
      </select></label>
      <label>Min gold to keep <input type="number" id="cfg-minGold"></label>

      <!-- TODO: bloodstones support removed for now -->

      <button id="bot-toggle" class="stopped">Start Bot</button>
    </div>
	`;

  document.body.appendChild(ui);

// const bind removed, use bindConfig now

  bindConfig('cfg-serverSpeed', 'serverSpeed', 'number');
  bindConfig('cfg-priorityAdventure', 'priorityAdventure');
  bindConfig('cfg-difficulty', 'difficulty');
  bindConfig('cfg-spendGoldOn', 'spendGoldOn');
  bindConfig('cfg-priorityAttribute', 'priorityAttribute');
  bindConfig('cfg-minGold', 'minGoldToKeep', 'number');

  document.getElementById('bot-toggle').onclick =
    () => botState.isRunning ? stopBot() : startBot();

  updateToggleButton(); // initial sync
}
	
/*********************************************************
* INIT 
*********************************************************/

createBotUI();

//Bot end//
})();
