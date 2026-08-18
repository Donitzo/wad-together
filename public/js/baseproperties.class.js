import MapTransformer from './wad/maptransformer.class.js';

/**
 * Base class which handles properties.
 */
export default class BaseProperties {
    /**
     * Property metadata class.
     */
    static Property = class Property {
        /* options = [{
            key: "key_name",
            // WAD property (can be per-port)
            [wadKey]: "key_name" / null,
            // Bit in WAD property (can be per-port)
            [wadKeyBit]: integer / null,
            [wadKeyBitCount]: integer / 1,
            // UDMF property (can be per-port)
            [udmfKey]: "key_name" / null,
            // Bit in UDMF property (can be per-port)
            [udmfKeyBit]: integer / null,
            [udmfKeyBitCount]: integer / 1,
            [label]: "Label",
            [tooltip]: "Tooltip",
            type: "integer/number/string/boolean",
            [isEnum]: false,
            // Autocomplete
            [datalist]: [
                { value: 0, label: "Label 1" },
                { value: 1, label: "Label 2" },
                { value: 2, label: "Label 3" }
            ],
            // For numbers (can be per-port)
            [range]: [0, 255],
            // For strings (can be per-port)
            [maxLength]: 8,
            [ports]: { doom_wad: true, doom_udmf: true, boom_wad: true, ... },
            default: 0,
            [udmfDefault]: default,
            [hidden]: false,
            [export]: true,
            [alwaysExport]: false,
        }]*/

        /**
         * Creates property metadata from a configuration object.
         *
         * @param {Object} [options={}] - The property definition.
         */
        constructor(options = Object.create(null)) {
            const get = (key, defaultValue = undefined) => {
                const value = options[key];
                if ((value === undefined || value === null) && defaultValue === undefined) {
                    throw new Error(`Non-optional argument ${key} omitted`);
                }
                return value ?? defaultValue;
            };

            const padPorts = (key, value) => {
                const out = Object.create(null);

                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    MapTransformer.PORTS.forEach(port => {
                        const v = value[port];
                        if (v === undefined) {
                            throw new Error(`Property "${key}" missing port "${port}"`);
                        }
                        out[port] = v;
                    });
                } else {
                    MapTransformer.PORTS.forEach(port => {
                        out[port] = value;
                    });
                }

                return out;
            };

            this.key = get('key');
            this.wadKey = padPorts('wadKey', get('wadKey', null));
            this.wadKeyBit = padPorts('wadKeyBit', get('wadKeyBit', null));
            this.wadKeyBitCount = padPorts('wadKeyBitCount', get('wadKeyBitCount', 1));
            this.udmfKey = padPorts('udmfKey', get('udmfKey', null));
            this.udmfKeyBit = padPorts('udmfKeyBit', get('udmfKeyBit', null));
            this.udmfKeyBitCount = padPorts('udmfKeyBitCount', get('udmfKeyBitCount', 1));
            this.label = get('label', this.key);
            this.tooltip = get('tooltip', '');
            this.type = get('type');
            if (!['integer', 'number', 'string', 'boolean'].includes(this.type)) {
                throw new Error(`Invalid property type "${this.type}"`);
            }
            this.isEnum = padPorts('isEnum', get('isEnum', false));
            this.datalist = padPorts('datalist', get('datalist', []));
            this.range = padPorts('range', get('range', [-Infinity, Infinity]));
            MapTransformer.PORTS.forEach(port => {
                const hardLimit = this.type === 'integer' ? 0x7fffffff : 1e308;
                this.range[port][0] = !Number.isFinite(this.range[port][0]) ? -hardLimit :
                    Math.max(this.range[port][0], -hardLimit);
                this.range[port][1] = !Number.isFinite(this.range[port][1]) ? hardLimit :
                    Math.min(this.range[port][1], hardLimit);
            });
            this.maxLength = padPorts('maxLength', get('maxLength', 256));
            this.ports = padPorts('ports', get('ports', true));
            this.default = get('default');
            this.udmfDefault = padPorts('udmfDefault', get('udmfDefault', this.default));
            this.hidden = get('hidden', false);
            this.export = get('export', true);
            this.alwaysExport = get('alwaysExport', false);
        }
    }

    static #tmpDataView = new DataView(new ArrayBuffer(8));

    /** @type {?Array<BaseProperties.Property>} Property schema supplied by each subclass. */
    static _properties = null;

    /** @type {?Map<string, BaseProperties.Property>} Property metadata indexed by key. */
    static _propertyByKey = null;

    /** @type {?Object<string, Map<string, Array<PropertyImportEntry>>>} Import maps indexed by port and source key. */
    static _importMap = null;

    /** @type {Map<string, boolean|number|string>} Property values indexed by key. */
    #values = new Map();

    /** @type {?number} Cached hash of the current property values. */
    #hash = null;

    /**
     * Initializes property metadata and per-port import lookup maps.
     *
     * @param {Array<BaseProperties.Property>} properties - The property metadata schema.
     */
    static setup(properties) {
        this._properties = properties;

        this._propertyByKey = new Map();

        this._importMap = Object.create(null);

        MapTransformer.PORTS.forEach(port => {
            this._importMap[port] = new Map();
        });

        this._properties.forEach(property => {
            this._propertyByKey.set(property.key, property);

            MapTransformer.PORTS.forEach(port => {
                if (!property.ports[port]) {
                    return;
                }

                const format = MapTransformer.PORT_EXPORT_FORMAT.get(port);

                const key = format === 'wad'
                    ? property.wadKey[port]
                    : property.udmfKey[port];

                if (key === null) {
                    return;
                }

                const entry = this._importMap[port].get(key) ?? [];

                entry.push({
                    property,
                    bit: format === 'wad'
                        ? property.wadKeyBit[port]
                        : property.udmfKeyBit[port],
                    bitCount: format === 'wad'
                        ? property.wadKeyBitCount[port]
                        : property.udmfKeyBitCount[port],
                });

                this._importMap[port].set(key, entry);
            });
        });
    }

    /**
     * Creates a property collection initialized to its schema defaults.
     */
    constructor() {
        this.reset();
    }

    /**
     * Invalidates the cached property-value hash.
     */
    invalidateHash() {
        this.#hash = null;
    }

    /**
     * Resets all property values to their schema defaults.
     */
    reset() {
        this.constructor._properties.forEach(property => {
            this.#values.set(property.key, property.default);
        });

        this.invalidateHash();
    }

    /**
     * Iterates over property values in schema order.
     *
     * @param {function(string, boolean|number|string, boolean|number|string, BaseProperties.Property)}
     *     callback - Receives the key, current value, default value, and metadata.
     * @param {boolean} [onlyNonDefault=false] - Whether to skip values equal to their defaults.
     */
    iterate(callback, onlyNonDefault = false) {
        this.constructor._properties.forEach(property => {
            const value = this.#values.get(property.key);
            if (!onlyNonDefault || value !== property.default) {
                callback(property.key, value, property.default, property);
            }
        });
    }

    /**
     * Retrieves the current value of a property.
     *
     * @param {string} key - The property key.
     * @returns {boolean|number|string} The current property value.
     */
    getValue(key) {
        const value = this.#values.get(key);
        if (value === undefined) {
            throw new Error(`Attempted to get invalid property "${key}"`);
        }
        return value;
    }

    /**
     * Sets the current value of a property.
     *
     * @param {string} key - The property key.
     * @param {boolean|number|string} value - The new property value.
     */
    setValue(key, value) {
        const oldValue = this.#values.get(key);
        if (oldValue === undefined) {
            throw new Error(`Attempted to set invalid property "${key}"`);
        }

        if (oldValue === value) {
            return;
        }

        this.#values.set(key, value);

        this.invalidateHash();
    }

    /**
     * Validates a property value against its type and port.
     *
     * @param {string} key - The property key.
     * @param {boolean|number|string} value - The value to validate.
     * @param {string} [port='gzdoom_udmf'] - The preferred target port.
     * @returns {boolean} Whether the value is valid for at least one applicable port.
     */
    static validate(key, value, port = 'gzdoom_udmf') {
        const property = this._propertyByKey.get(key);
        if (property === undefined) {
            return false;
        }

        const ports = property.ports[port]
            ? [port]
            : Object.keys(property.ports).filter(candidatePort => property.ports[candidatePort]);

        if (ports.length === 0) {
            return false;
        }

        switch (property.type) {
            case 'boolean':
                return typeof value === 'boolean';

            case 'integer': {
                if (!Number.isInteger(value)) {
                    return false;
                }

                return ports.some(validationPort => {
                    const [min, max] = property.range[validationPort];
                    return value >= min && value <= max;
                });
            }

            case 'number': {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    return false;
                }

                return ports.some(validationPort => {
                    const [min, max] = property.range[validationPort];
                    return value >= min && value <= max;
                });
            }

            case 'string': {
                if (typeof value !== 'string') {
                    return false;
                }

                for (let i = 0; i < value.length; i++) {
                    const code = value.charCodeAt(i);

                    if (code < 32 || code > 126) {
                        return false;
                    }
                }

                return ports.some(validationPort => value.length <= property.maxLength[validationPort]);
            }

            default:
                return false;
        }
    }

    /**
     * Copies all property values from another property collection.
     *
     * @param {BaseProperties} other - The property collection to copy.
     */
    copy(other) {
        other.#values.forEach((value, key) => {
            this.#values.set(key, value);
        });
        this.invalidateHash();
    }

    /**
     * Serializes the property values as key-value pairs. Skips non-exportable properties.
     *
     * @returns {Object} The serialized property entries.
     */
    serialize() {
        const entries = [];

        this.constructor._properties.forEach(property => {
            if (!property.export) {
                return;
            }

            entries.push([
                property.key,
                this.#values.get(property.key),
            ]);
        });

        return entries;
    }
    /**
     * Restores known property values from serialized key-value pairs.
     *
     * @param {Object} data - The serialized property entries.
     */
    deserialize(data) {
        data.forEach(([key, value]) => {
            if (this.#values.has(key)) {
                this.#values.set(key, value);
            }
        });

        this.invalidateHash();
    }

    /**
     * Exports property values using the keys and packing rules for a target port.
     *
     * @param {string} port - The target port identifier.
     * @returns {Object} The exported WAD or UDMF properties.
     */
    export(port) {
        const format = MapTransformer.PORT_EXPORT_FORMAT.get(port);

        if (format === undefined) {
            throw new Error(`Invalid port "${port}"`);
        }

        const properties = Object.create(null);

        const bitBuckets = new Map();
        const exportBitBucket = new Set();

        const includeDefaults = format === 'wad';

        const getKey = property => format === 'wad'
            ? property.wadKey[port]
            : property.udmfKey[port];
        const getBit = property => format === 'wad'
            ? property.wadKeyBit[port]
            : property.udmfKeyBit[port];
        const getBitCount = property => format === 'wad'
            ? property.wadKeyBitCount[port]
            : property.udmfKeyBitCount[port];
        const getExportDefault = property => format === 'udmf'
            ? property.udmfDefault[port]
            : property.default;
        const getPackedValue = (property, value, bitCount) => {
            if (property.type === 'boolean') {
                return value ? 1 : 0;
            }

            if (!Number.isInteger(value)) {
                throw new Error(`Packed property "${property.key}" must be an integer`);
            }

            const maxValue = (1 << bitCount) - 1;

            if (value < 0 || value > maxValue) {
                throw new Error(`Packed property "${property.key}" value ${value} does not fit in ${bitCount} bits`);
            }

            return value;
        };
        const setPackedBits = (property, packed, bit, bitCount, value) => {
            const mask = (1 << bitCount) - 1;
            const packedValue = getPackedValue(property, value, bitCount);

            return (packed & ~(mask << bit)) | ((packedValue & mask) << bit);
        };

        this.constructor._properties.forEach(property => {
            if (!property.ports[port] || !property.export) {
                return;
            }

            const key = getKey(property);
            if (key === null) {
                return;
            }

            const bit = getBit(property);
            if (bit === null) {
                return;
            }

            const bitCount = getBitCount(property);
            const defaultValue = getExportDefault(property);
            const previous = bitBuckets.get(key) ?? 0;

            bitBuckets.set(key, setPackedBits(property, previous, bit, bitCount, defaultValue));

            if (includeDefaults || property.alwaysExport) {
                exportBitBucket.add(key);
            }
        });

        this.constructor._properties.forEach(property => {
            if (!property.ports[port] || !property.export) {
                return;
            }

            const key = getKey(property);
            if (key === null) {
                return;
            }

            const value = this.#values.get(property.key);
            const bit = getBit(property);
            const exportDefault = getExportDefault(property);

            if (bit !== null) {
                const bitCount = getBitCount(property);
                const previous = bitBuckets.get(key) ?? 0;

                bitBuckets.set(key, setPackedBits(property, previous, bit, bitCount, value));

                if (includeDefaults || property.alwaysExport || value !== exportDefault) {
                    exportBitBucket.add(key);
                }

                return;
            }

            if (!includeDefaults && !property.alwaysExport && value === exportDefault) {
                return;
            }

            properties[key] = value;
        });

        bitBuckets.forEach((packed, key) => {
            if (exportBitBucket.has(key)) {
                properties[key] = packed;
            }
        });

        return properties;
    }

    /**
     * Imports recognized property values from WAD or UDMF data for a target port.
     *
     * @param {string} port - The source port identifier.
     * @param {Object} properties - The source property values.
     */
    import(port, properties) {
        const format = MapTransformer.PORT_EXPORT_FORMAT.get(port);

        if (format === undefined) {
            throw new Error(`Invalid port "${port}"`);
        }

        const map = this.constructor._importMap[port];
        if (map === undefined) {
            throw new Error(`Invalid port "${port}"`);
        }

        this.constructor._properties.forEach(property => {
            const defaultValue = format === 'udmf'
                ? property.udmfDefault[port]
                : property.default;

            this.#values.set(property.key, defaultValue);
        });

        for (const [key, value] of Object.entries(properties)) {
            const entries = map.get(key.toLowerCase());
            if (entries === undefined) {
                continue;
            }

            for (const { property, bit, bitCount } of entries) {
                if (bit !== null) {
                    const mask = (1 << bitCount) - 1;
                    const unpacked = (value >> bit) & mask;

                    this.#values.set(
                        property.key,
                        property.type === 'boolean' ? unpacked !== 0 : unpacked
                    );
                } else {
                    this.#values.set(property.key, value);
                }
            }
        }

        this.invalidateHash();
    }

    /**
     * Checks whether a property has different values across a collection.
     *
     * @param {Array<BaseProperties>} propertiesList - The property collections to compare.
     * @param {string} key - The property key.
     * @returns {boolean} Whether the property has multiple distinct values.
     */
    static #isMultiValue(propertiesList, key) {
        let firstSet = false;
        let firstValue;

        for (const properties of propertiesList) {
            const value = properties.#values.get(key);
            if (!firstSet) {
                firstSet = true;
                firstValue = value;
            } else if (value !== firstValue) {
                return true;
            }
        }

        return false;
    }

    /**
     * Builds editable inspector controls for one or more property collections.
     *
     * @param {ResourceManager} resourceManager - The resource manager used for thing definitions.
     * @param {Array<BaseProperties>} propertiesList - The property collections being inspected.
     * @param {HTMLElement} container - The element that receives the inspector rows.
     * @param {string} port - The active target port.
     * @param {function(string, (boolean|number|string))} changeCallback - Called with each property change.
     */
    static createInspector(resourceManager, propertiesList, container, port, changeCallback) {
        container.innerHTML = '';

        if (propertiesList.length === 0) {
            return;
        }

        const first = propertiesList[0];

        const properties = first.constructor._properties;
        properties.forEach(property => {
            if (!property.ports[port] || property.hidden) {
                return;
            }

            const value = first.#values.get(property.key);
            const isMultiValue = this.#isMultiValue(propertiesList, property.key);

            const label = document.createElement('label');
            label.textContent = property.label;
            label.title = property.tooltip;
            label.htmlFor = `input-${first.constructor.name}-${property.key}`;

            const isEnum = property.isEnum[port] === true;
            const input = isEnum ? document.createElement('select') : document.createElement('input');

            input.classList.toggle('input--multivalue', isMultiValue);
            input.title = property.tooltip;
            input.id = `input-${first.constructor.name}-${property.key}`;

            if (isEnum) {
                if (isMultiValue) {
                    const option = document.createElement('option');
                    option.value = '';
                    option.textContent = '';
                    option.selected = true;
                    option.disabled = true;
                    input.appendChild(option);
                }

                property.datalist[port].forEach(entry => {
                    const option = document.createElement('option');
                    option.value = String(entry.value);
                    if (Number.isFinite(entry.value)) {
                        option.textContent = `${entry.label} (${entry.value})`;
                    } else {
                        option.textContent = `${entry.label}`;
                    }
                    input.appendChild(option);
                });

                if (!isMultiValue) {
                    input.value = String(value);
                }

                input.addEventListener('change', () => {
                    let v = input.value;

                    if (property.type === 'integer') {
                        v = parseInt(v, 10);
                    } else if (property.type === 'number') {
                        v = parseFloat(v);
                    }

                    changeCallback(property.key, v);
                });
            } else {
                let datalist = null;
                if (property.datalist[port].length > 0) {
                    datalist = document.createElement('datalist');
                    datalist.id = `datalist-${first.constructor.name}-${property.key}`;

                    property.datalist[port].forEach(entry => {
                        const option = document.createElement('option');
                        option.value = String(entry.value);
                        option.label = `${entry.label} (${entry.value})`;
                        datalist.appendChild(option);
                    });
                }

                switch (property.type) {
                    case 'boolean': {
                        input.type = 'checkbox';
                        input.checked = isMultiValue ? false : value;
                        input.indeterminate = isMultiValue;
                        input.addEventListener('change', () => {
                            input.indeterminate = false;
                            changeCallback(property.key, input.checked);
                        });
                        break;
                    }

                    case 'integer':
                    case 'number': {
                        input.type = 'number';
                        const [min, max] = property.range[port];
                        if (Number.isFinite(min)) {
                            input.min = min;
                        }
                        if (Number.isFinite(max)) {
                            input.max = max;
                        }
                        input.value = isMultiValue ? '' : value;
                        input.addEventListener('change', () => {
                            const number = property.type === 'integer'
                                ? parseInt(input.value, 10)
                                : parseFloat(input.value);
                            const valid = first.constructor.validate(property.key, number, port);
                            input.classList.toggle('input--invalid', !valid);
                            if (valid) {
                                changeCallback(property.key, number);
                            }
                        });
                        if (datalist !== null) {
                            input.setAttribute('list', datalist.id);
                            input.after(datalist);
                        }
                        input.setAttribute('data-scrubber-pixels-per-step', '2');
                        input.setAttribute('data-scrubber-vertical', '1');
                        break;
                    }

                    case 'string': {
                        input.type = 'text';
                        input.maxLength = property.maxLength[port];
                        input.value = isMultiValue ? '' : value;
                        input.addEventListener('change', () => {
                            const valid = first.constructor.validate(property.key, input.value, port);
                            input.classList.toggle('input--invalid', !valid);
                            if (valid) {
                                changeCallback(property.key, input.value);
                            }
                        });
                        if (datalist !== null) {
                            input.setAttribute('list', datalist.id);
                            input.after(datalist);
                        }
                        break;
                    }
                }
            }

            const row = document.createElement('tr');

            const labelElement = document.createElement('td');
            const valueElement = document.createElement('td');

            labelElement.append(label);
            valueElement.append(input);

            row.append(labelElement, valueElement);

            if (first.constructor.name === 'ThingProperties' && property.key === 'type' && !isMultiValue) {
                const definition = resourceManager.thingDefinitions.find(d => d.id === value);

                const nameRow = document.createElement('tr');

                const nameLabelElement = document.createElement('td');
                const nameValueElement = document.createElement('td');

                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.value = definition?.name ?? 'Unknown thing';
                nameInput.readOnly = true;

                nameLabelElement.textContent = 'Thing Name';
                nameValueElement.append(nameInput);

                nameRow.append(nameLabelElement, nameValueElement);

                container.appendChild(nameRow);
            }

            container.appendChild(row);
        });
    }

    /**
     * Computes a stable hash of all current property values.
     *
     * @returns {number} The 32-bit property hash.
     */
    hash() {
        if (this.#hash !== null) {
            return this.#hash;
        }

        const dv = BaseProperties.#tmpDataView;

        // FNV-1a base
        let h = 2166136261 >>> 0;

        this.constructor._properties.forEach(property => {
            const value = this.#values.get(property.key);

            switch (property.type) {
                case 'boolean':
                case 'integer':
                    h ^= +value;
                    h = Math.imul(h, 16777619);
                    break;

                case 'number':
                    dv.setFloat64(0, value);
                    h ^= dv.getInt32(0);
                    h = Math.imul(h, 16777619);
                    h ^= dv.getInt32(4);
                    h = Math.imul(h, 16777619);
                    break;

                case 'string':
                    for (let i = 0; i < value.length; i++) {
                        h ^= value.charCodeAt(i);
                        h = Math.imul(h, 16777619);
                    }
                    h ^= 0;
                    h = Math.imul(h, 16777619);
                    break;

                default:
                    throw new Error(`Unsupported hash type for "${property.key}"`);
            }
        });

        this.#hash = h >>> 0;

        return this.#hash;
    }
}
