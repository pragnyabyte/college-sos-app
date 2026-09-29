import { randomUUID } from 'node:crypto';

function setNested(obj, keyPath, val) {
  if (!keyPath.includes('.')) {
    obj[keyPath] = val;
    return;
  }
  const parts = keyPath.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!curr[p] || typeof curr[p] !== 'object') {
      curr[p] = {};
    }
    curr = curr[p];
  }
  curr[parts[parts.length - 1]] = val;
}

function unsetNested(obj, keyPath) {
  if (!keyPath.includes('.')) {
    delete obj[keyPath];
    return;
  }
  const parts = keyPath.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!curr[parts[i]]) return;
    curr = curr[parts[i]];
  }
  delete curr[parts[parts.length - 1]];
}

class MemoryCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
  }

  async createIndex() {
    return 'index_created';
  }

  _matches(doc, filter = {}) {
    if (!filter || Object.keys(filter).length === 0) return true;

    for (const [key, val] of Object.entries(filter)) {
      if (key === '$or') {
        const anyMatch = val.some(subFilter => this._matches(doc, subFilter));
        if (!anyMatch) return false;
        continue;
      }

      let docVal;
      if (key.includes('.')) {
        const parts = key.split('.');
        let current = doc;
        for (const p of parts) {
          current = current ? current[p] : undefined;
        }
        docVal = current;
      } else {
        docVal = doc[key];
      }

      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if ('$in' in val) {
          if (!Array.isArray(val.$in) || !val.$in.includes(docVal)) return false;
          continue;
        }
        if ('$nin' in val) {
          if (Array.isArray(val.$nin) && val.$nin.includes(docVal)) return false;
          continue;
        }
        if ('$ne' in val) {
          if (docVal === val.$ne) return false;
          continue;
        }
        if ('$gte' in val) {
          if (docVal < val.$gte) return false;
          continue;
        }
        if ('$lte' in val) {
          if (docVal > val.$lte) return false;
          continue;
        }
        if ('$exists' in val) {
          const exists = docVal !== undefined;
          if (exists !== Boolean(val.$exists)) return false;
          continue;
        }
        if ('$regex' in val) {
          const regex = new RegExp(val.$regex, val.$options || '');
          if (!regex.test(String(docVal || ''))) return false;
          continue;
        }
      }

      if (String(docVal) !== String(val)) {
        return false;
      }
    }
    return true;
  }

  async findOne(filter = {}) {
    const found = this.docs.find(d => this._matches(d, filter));
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  find(filter = {}, options = {}) {
    let results = this.docs.filter(d => this._matches(d, filter)).map(d => JSON.parse(JSON.stringify(d)));
    return {
      sort: (sortObj = {}) => {
        const [field, dir] = Object.entries(sortObj)[0] || [];
        if (field) {
          results.sort((a, b) => {
            if (a[field] < b[field]) return dir === 1 ? -1 : 1;
            if (a[field] > b[field]) return dir === 1 ? 1 : -1;
            return 0;
          });
        }
        return {
          limit: (n) => ({
            toArray: async () => results.slice(0, n)
          }),
          toArray: async () => results
        };
      },
      limit: (n) => ({
        toArray: async () => results.slice(0, n)
      }),
      toArray: async () => results
    };
  }

  async insertOne(doc) {
    const clone = JSON.parse(JSON.stringify(doc));
    if (!clone._id) clone._id = 'mem_' + randomUUID();
    this.docs.push(clone);
    return { insertedId: clone._id, acknowledged: true };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    let index = this.docs.findIndex(d => this._matches(d, filter));
    if (index === -1) {
      if (options.upsert) {
        const newDoc = { ...(filter._id ? { _id: filter._id } : {}), ...filter };
        if (update.$setOnInsert) {
          for (const [k, v] of Object.entries(update.$setOnInsert)) {
            setNested(newDoc, k, JSON.parse(JSON.stringify(v)));
          }
        }
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) {
            newDoc[k] = (newDoc[k] || 0) + v;
          }
        }
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            setNested(newDoc, k, JSON.parse(JSON.stringify(v)));
          }
        }
        if (!newDoc._id) newDoc._id = 'mem_' + randomUUID();
        this.docs.push(newDoc);
        return JSON.parse(JSON.stringify(newDoc));
      }
      return null;
    }

    const doc = this.docs[index];
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        doc[k] = (doc[k] || 0) + v;
      }
    }
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        setNested(doc, k, JSON.parse(JSON.stringify(v)));
      }
    }
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) {
        unsetNested(doc, k);
      }
    }
    return JSON.parse(JSON.stringify(doc));
  }

  async updateOne(filter, update, options = {}) {
    return this.findOneAndUpdate(filter, update, options);
  }

  async updateMany(filter, update, options = {}) {
    let modifiedCount = 0;
    for (let i = 0; i < this.docs.length; i++) {
      if (this._matches(this.docs[i], filter)) {
        const doc = this.docs[i];
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) {
            doc[k] = (doc[k] || 0) + v;
          }
        }
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            setNested(doc, k, JSON.parse(JSON.stringify(v)));
          }
        }
        if (update.$unset) {
          for (const k of Object.keys(update.$unset)) {
            unsetNested(doc, k);
          }
        }
        modifiedCount++;
      }
    }
    return { matchedCount: modifiedCount, modifiedCount, acknowledged: true };
  }

  async deleteOne(filter) {
    const idx = this.docs.findIndex(d => this._matches(d, filter));
    if (idx !== -1) {
      this.docs.splice(idx, 1);
      return { deletedCount: 1, acknowledged: true };
    }
    return { deletedCount: 0, acknowledged: true };
  }

  async deleteMany(filter) {
    const initialLen = this.docs.length;
    this.docs = this.docs.filter(d => !this._matches(d, filter));
    return { deletedCount: initialLen - this.docs.length, acknowledged: true };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter(d => this._matches(d, filter)).length;
  }

  async bulkWrite(ops = []) {
    for (const op of ops) {
      if (op.updateOne) {
        await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
      }
    }
    return { ok: 1 };
  }
}

export function createInMemoryDb() {
  const collections = new Map();
  return {
    databaseName: 'school_erp_sos_in_memory',
    collection: (name) => {
      if (!collections.has(name)) {
        collections.set(name, new MemoryCollection(name));
      }
      return collections.get(name);
    }
  };
}
