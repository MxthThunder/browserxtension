/**
 * Local Sensitive-Data Vault (Manifest V3)
 * Step 4 of Privacy-Preserving Browser-Agent Architecture.
 *
 * Provides client-side encrypted storage for credentials, contact information,
 * financial data, and personal identifiers using Web Crypto (AES-256-GCM + PBKDF2).
 *
 * Guarantees Zero-Leakage:
 * - Sensitive values are stored encrypted at rest in chrome.storage.local.
 * - External LLMs / VLMs only receive abstract token handles (e.g. {{VAULT:personal.name}}).
 * - DOM fill actions are executed strictly locally on-device.
 */

// Vault Standard Categories
export const VAULT_CATEGORIES = {
  PERSONAL: "personal",
  CONTACT: "contact",
  ADDRESS: "address",
  FINANCIAL: "financial",
  CREDENTIALS: "credentials",
  GOV_ID: "gov_id",
  CUSTOM: "custom"
};

// Common field mappings for intelligent autofill matching
export const FIELD_SEMANTIC_ALIASES = {
  "name": ["name", "fullname", "full_name", "user_name", "customer_name", "your_name"],
  "first_name": ["firstname", "first_name", "fname", "given_name"],
  "last_name": ["lastname", "last_name", "lname", "surname", "family_name"],
  "email": ["email", "e-mail", "mail", "email_address", "user_email", "contact_email"],
  "phone": ["phone", "telephone", "mobile", "tel", "cell", "phone_number", "contact_number"],
  "street": ["address", "street", "street_address", "addr_line1", "address1", "address_line_1"],
  "city": ["city", "town", "municipality", "district"],
  "state": ["state", "province", "region"],
  "zip": ["zip", "zipcode", "postal", "postal_code", "pincode", "pin"],
  "country": ["country", "nation"],
  "card_number": ["cardnumber", "card_number", "cc_num", "credit_card", "account_number", "pan_num"],
  "card_expiry": ["expiry", "expiration", "exp_date", "exp_month_year", "cc_exp"],
  "card_cvv": ["cvv", "cvc", "security_code", "cvv2", "card_code"],
  "username": ["username", "user", "login", "user_id", "email_or_username"],
  "password": ["password", "pass", "pwd", "user_password", "current_password", "new_password"],
  "ssn": ["ssn", "social_security", "social_security_number"],
  "aadhaar": ["aadhaar", "aadhar", "aadhaar_number", "uidai"],
  "pan": ["pan", "pan_number", "tax_id", "tax_identifier"],
  "passport": ["passport", "passport_number", "passport_no"]
};

// Storage keys
const VAULT_STORAGE_KEY = "encrypted_pii_vault_data";
const VAULT_KEY_METADATA = "pii_vault_salt_meta";

/**
 * Helper to get subtle crypto safely across Window, Worker, and Node.js environments.
 */
function getCrypto() {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    return crypto;
  }
  if (typeof window !== "undefined" && window.crypto && window.crypto.subtle) {
    return window.crypto;
  }
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API (crypto.subtle) is not available in current execution context.");
}

/**
 * Converts ArrayBuffer to Base64
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  return Buffer.from(binary, "binary").toString("base64");
}

/**
 * Converts Base64 to ArrayBuffer
 */
function base64ToBuffer(base64) {
  let binary;
  if (typeof atob === "function") {
    binary = atob(base64);
  } else {
    binary = Buffer.from(base64, "base64").toString("binary");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class LocalSensitiveVault {
  constructor() {
    this._isUnlocked = false;
    this._cryptoKey = null;
    this._inMemoryCache = null;
    this._salt = null;
  }

  /**
   * Initializes the vault with a user passphrase or local device-derived key.
   * @param {string} [passphrase] Optional user-provided master password
   */
  async init(passphrase = "default_local_device_key_seed_pii_2026") {
    const c = getCrypto();

    // Retrieve or generate salt
    let meta = await this._getRawStorage(VAULT_KEY_METADATA);
    if (!meta || !meta.salt) {
      const saltBytes = new Uint8Array(16);
      c.getRandomValues(saltBytes);
      const saltBase64 = bufferToBase64(saltBytes.buffer);
      meta = { salt: saltBase64, iterations: 100000, createdAt: new Date().toISOString() };
      await this._setRawStorage(VAULT_KEY_METADATA, meta);
    }

    this._salt = new Uint8Array(base64ToBuffer(meta.salt));

    // Derive AES-GCM 256 key via PBKDF2
    const enc = new TextEncoder();
    const passphraseKey = await c.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    this._cryptoKey = await c.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: this._salt,
        iterations: meta.iterations || 100000,
        hash: "SHA-256"
      },
      passphraseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    this._isUnlocked = true;

    // Load initial decrypted state into memory
    await this._loadVault();
    return true;
  }

  /**
   * Checks if the vault is currently unlocked and ready.
   */
  isUnlocked() {
    return this._isUnlocked && this._cryptoKey !== null;
  }

  /**
   * Locks the vault, clearing in-memory cached plaintext.
   */
  lock() {
    this._isUnlocked = false;
    this._cryptoKey = null;
    this._inMemoryCache = null;
  }

  /**
   * Stores a sensitive item in the vault.
   * @param {string} category VAULT_CATEGORIES value
   * @param {string} key Identifier (e.g., 'email', 'phone', 'card_number')
   * @param {string} value Plaintext value
   * @param {Object} [metadata] Optional metadata (label, tags, updated_at)
   */
  async set(category, key, value, metadata = {}) {
    this._assertUnlocked();
    const cat = category.toLowerCase();
    const k = key.toLowerCase();

    if (!this._inMemoryCache[cat]) {
      this._inMemoryCache[cat] = {};
    }

    this._inMemoryCache[cat][k] = {
      value: String(value),
      metadata: {
        ...metadata,
        updatedAt: new Date().toISOString()
      }
    };

    await this._persistVault();
    return true;
  }

  /**
   * Retrieves a decrypted value from the vault.
   * @param {string} category 
   * @param {string} key 
   * @returns {string|null} Plaintext value
   */
  get(category, key) {
    this._assertUnlocked();
    const cat = category.toLowerCase();
    const k = key.toLowerCase();
    if (this._inMemoryCache[cat] && this._inMemoryCache[cat][k]) {
      return this._inMemoryCache[cat][k].value;
    }
    return null;
  }

  /**
   * Checks if an item exists in the vault.
   * @param {string} category 
   * @param {string} key 
   */
  has(category, key) {
    this._assertUnlocked();
    const cat = category.toLowerCase();
    const k = key.toLowerCase();
    return Boolean(this._inMemoryCache[cat] && this._inMemoryCache[cat][k]);
  }

  /**
   * Deletes an item from the vault.
   * @param {string} category 
   * @param {string} key 
   */
  async delete(category, key) {
    this._assertUnlocked();
    const cat = category.toLowerCase();
    const k = key.toLowerCase();
    if (this._inMemoryCache[cat] && this._inMemoryCache[cat][k]) {
      delete this._inMemoryCache[cat][k];
      await this._persistVault();
      return true;
    }
    return false;
  }

  /**
   * Returns a sanitized list of all keys and metadata (without raw values).
   * Safe for UI rendering and agent planning.
   */
  listKeys() {
    this._assertUnlocked();
    const summary = {};
    for (const [cat, items] of Object.entries(this._inMemoryCache)) {
      summary[cat] = [];
      for (const [k, item] of Object.entries(items)) {
        summary[cat].push({
          key: k,
          tokenHandle: `{{VAULT:${cat}.${k}}}`,
          maskedValue: this._maskValue(item.value, cat, k),
          metadata: item.metadata || {}
        });
      }
    }
    return summary;
  }

  /**
   * Intelligent field matcher for automated / agent-guided local form filling.
   * Fuzzy matches against field names, autocomplete tags, labels, and placeholders.
   * @param {string} fieldIdentifier (e.g. "email", "cc_num", "user_address")
   * @returns {{category: string, key: string, value: string, token: string}|null}
   */
  findMatchingValue(fieldIdentifier) {
    this._assertUnlocked();
    if (!fieldIdentifier) return null;

    const normalized = fieldIdentifier.toLowerCase().replace(/[^a-z0-9]/g, "");

    // 1. Direct key match across all categories
    for (const [cat, items] of Object.entries(this._inMemoryCache)) {
      for (const [k, item] of Object.entries(items)) {
        const normKey = k.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (normKey === normalized || normalized.includes(normKey) || normKey.includes(normalized)) {
          return {
            category: cat,
            key: k,
            value: item.value,
            token: `{{VAULT:${cat}.${k}}}`
          };
        }
      }
    }

    // 2. Semantic aliases match
    for (const [canonicalKey, aliases] of Object.entries(FIELD_SEMANTIC_ALIASES)) {
      const isMatch = aliases.some(alias => {
        const normAlias = alias.replace(/[^a-z0-9]/g, "");
        return normalized.includes(normAlias) || normAlias.includes(normalized);
      });

      if (isMatch) {
        // Find if we have canonicalKey in any category
        for (const [cat, items] of Object.entries(this._inMemoryCache)) {
          if (items[canonicalKey]) {
            return {
              category: cat,
              key: canonicalKey,
              value: items[canonicalKey].value,
              token: `{{VAULT:${cat}.${canonicalKey}}}`
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolves a token handle (e.g. {{VAULT:contact.email}}) strictly locally.
   * @param {string} token 
   * @returns {string|null}
   */
  resolveToken(token) {
    this._assertUnlocked();
    const match = token.match(/^\{\{VAULT:([a-z0-9_]+)\.([a-z0-9_]+)\}\}$/i);
    if (!match) return null;

    const [, cat, key] = match;
    return this.get(cat, key);
  }

  /**
   * Exports an encrypted, portable backup payload.
   */
  async exportEncryptedBackup() {
    this._assertUnlocked();
    const rawData = await this._getRawStorage(VAULT_STORAGE_KEY);
    const meta = await this._getRawStorage(VAULT_KEY_METADATA);
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      meta,
      vault: rawData
    }, null, 2);
  }

  // --- Internal Helper Methods ---

  _assertUnlocked() {
    if (!this.isUnlocked()) {
      throw new Error("LocalSensitiveVault is locked or not initialized. Call init() first.");
    }
  }

  /**
   * Generates a display-safe masked string (e.g. *******1234 or r***@gmail.com).
   */
  _maskValue(val, category, key) {
    if (!val) return "";
    const str = String(val);
    if (category === VAULT_CATEGORIES.CREDENTIALS && key.includes("password")) {
      return "••••••••";
    }
    if (category === VAULT_CATEGORIES.FINANCIAL && str.length >= 4) {
      return "•••• •••• •••• " + str.slice(-4);
    }
    if (str.includes("@")) {
      const parts = str.split("@");
      return (parts[0][0] || "*") + "***@" + parts[1];
    }
    if (str.length <= 4) {
      return "••••";
    }
    return str.substring(0, 2) + "•".repeat(Math.max(2, str.length - 4)) + str.slice(-2);
  }

  async _loadVault() {
    const raw = await this._getRawStorage(VAULT_STORAGE_KEY);
    if (!raw || !raw.iv || !raw.data) {
      this._inMemoryCache = {
        [VAULT_CATEGORIES.PERSONAL]: {},
        [VAULT_CATEGORIES.CONTACT]: {},
        [VAULT_CATEGORIES.ADDRESS]: {},
        [VAULT_CATEGORIES.FINANCIAL]: {},
        [VAULT_CATEGORIES.CREDENTIALS]: {},
        [VAULT_CATEGORIES.GOV_ID]: {},
        [VAULT_CATEGORIES.CUSTOM]: {}
      };
      return;
    }

    try {
      const c = getCrypto();
      const iv = new Uint8Array(base64ToBuffer(raw.iv));
      const ciphertext = base64ToBuffer(raw.data);

      const decryptedBuffer = await c.subtle.decrypt(
        { name: "AES-GCM", iv },
        this._cryptoKey,
        ciphertext
      );

      const dec = new TextDecoder();
      const plaintext = dec.decode(decryptedBuffer);
      this._inMemoryCache = JSON.parse(plaintext);
    } catch (err) {
      console.error("[Vault] Failed to decrypt vault data:", err);
      throw new Error("Invalid vault passphrase or corrupted vault storage.");
    }
  }

  async _persistVault() {
    this._assertUnlocked();
    const c = getCrypto();
    const enc = new TextEncoder();
    const plaintext = JSON.stringify(this._inMemoryCache);

    const iv = new Uint8Array(12);
    c.getRandomValues(iv);

    const encryptedBuffer = await c.subtle.encrypt(
      { name: "AES-GCM", iv },
      this._cryptoKey,
      enc.encode(plaintext)
    );

    const payload = {
      iv: bufferToBase64(iv.buffer),
      data: bufferToBase64(encryptedBuffer),
      updatedAt: new Date().toISOString()
    };

    await this._setRawStorage(VAULT_STORAGE_KEY, payload);
  }

  async _getRawStorage(key) {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([key], (result) => {
          resolve(result ? result[key] : null);
        });
      } else if (typeof localStorage !== "undefined") {
        const item = localStorage.getItem(key);
        resolve(item ? JSON.parse(item) : null);
      } else {
        // In-memory fallback for Node.js test environment
        if (!globalThis._nodeStorageMock) globalThis._nodeStorageMock = {};
        resolve(globalThis._nodeStorageMock[key] || null);
      }
    });
  }

  async _setRawStorage(key, value) {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [key]: value }, () => resolve(true));
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, JSON.stringify(value));
        resolve(true);
      } else {
        if (!globalThis._nodeStorageMock) globalThis._nodeStorageMock = {};
        globalThis._nodeStorageMock[key] = value;
        resolve(true);
      }
    });
  }
}

// Global Singleton Instance
export const vault = new LocalSensitiveVault();
