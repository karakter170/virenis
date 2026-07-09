import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialData(seedAgents) {
  const now = new Date().toISOString();
  return {
    version: 1,
    created_at: now,
    sessions: [],
    messages: [],
    runs: [],
    runSteps: [],
    agents: clone(seedAgents),
    documents: [],
    validationRuns: []
  };
}

export class JsonStore {
  constructor({ dbPath, seedAgents }) {
    this.dbPath = dbPath;
    this.seedAgents = seedAgents;
    this.data = initialData(seedAgents);
    this.txQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.dbPath, "utf8");
      this.data = JSON.parse(raw);
      this.mergeSeedAgents();
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.data = initialData(this.seedAgents);
      await this.saveNow();
    }
  }

  mergeSeedAgents() {
    const existing = new Set(this.data.agents.map((agent) => agent.id));
    for (const agent of this.seedAgents) {
      if (!existing.has(agent.id)) {
        this.data.agents.push(clone(agent));
      }
    }
  }

  read(selector = (data) => data) {
    return clone(selector(this.data));
  }

  mutate(mutator) {
    const transaction = this.txQueue.then(async () => {
      const result = mutator(this.data);
      await this.saveNow();
      return clone(result);
    });
    this.txQueue = transaction.catch(() => undefined);
    return transaction;
  }

  async saveNow() {
    const tmpPath = `${this.dbPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.dbPath);
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
