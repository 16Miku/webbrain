//#region node_modules/@huggingface/tokenizers/dist/tokenizers.mjs
var DictionarySplitter = class {
	/**
	* @param dictionary The dictionary of words to use for splitting.
	*/
	constructor(dictionary) {
		this.trie = this._build_trie(dictionary);
	}
	/**
	* Builds a trie from the given dictionary.
	* @param dictionary The dictionary of words to build the trie from.
	* @returns The root node of the trie.
	* @private
	*/
	_build_trie(dictionary) {
		const trie = /* @__PURE__ */ Object.create(null);
		for (const word of dictionary) {
			let node = trie;
			for (let i = 0; i < word.length; ++i) {
				const char = word[i];
				node = node[char] ??= /* @__PURE__ */ Object.create(null);
			}
			node.end = word;
		}
		return trie;
	}
	/**
	* Splits the input text into tokens based on the dictionary.
	* @param text The input text to split.
	* @returns An array of tokens.
	*/
	split(text) {
		const result = [];
		const n = text.length;
		let start = 0;
		let i = 0;
		while (i < n) {
			let node = this.trie;
			let match = null;
			let j = i;
			while (j < n && (node = node[text[j]])) {
				if (node.end) match = node.end;
				++j;
			}
			if (match) {
				if (i > start) result.push(text.slice(start, i));
				result.push(match);
				i += match.length;
				start = i;
			} else ++i;
		}
		if (start < n) result.push(text.slice(start));
		return result;
	}
};
var DictionarySplitter_default = DictionarySplitter;
var AddedToken = class {
	/**
	* Creates a new instance of AddedToken.
	* @param config Added token configuration object.
	*/
	constructor(config) {
		this.content = config.content;
		this.id = config.id;
		this.single_word = config.single_word ?? false;
		this.lstrip = config.lstrip ?? false;
		this.rstrip = config.rstrip ?? false;
		this.special = config.special ?? false;
		this.normalized = config.normalized ?? !this.special;
	}
};
var AddedToken_default = AddedToken;
var BYTES_TO_UNICODE = (() => {
	const bs = [
		...Array.from({ length: "~".charCodeAt(0) - "!".charCodeAt(0) + 1 }, (_, i) => i + "!".charCodeAt(0)),
		...Array.from({ length: "¬".charCodeAt(0) - "¡".charCodeAt(0) + 1 }, (_, i) => i + "¡".charCodeAt(0)),
		...Array.from({ length: "ÿ".charCodeAt(0) - "®".charCodeAt(0) + 1 }, (_, i) => i + "®".charCodeAt(0))
	];
	const cs = bs.slice();
	let n = 0;
	for (let b = 0; b < 256; ++b) if (!bs.includes(b)) {
		bs.push(b);
		cs.push(256 + n);
		n += 1;
	}
	const ccs = cs.map((n2) => String.fromCharCode(n2));
	return Object.fromEntries(bs.map((b, i) => [b, ccs[i]]));
})();
var reverse_dictionary = (data) => Object.fromEntries(Object.entries(data).map(([key, value]) => [value, key]));
var UNICODE_TO_BYTES = reverse_dictionary(BYTES_TO_UNICODE);
var BLOOM_SPLIT_CHARS = ".,!?…。，、।۔،";
var PROBLEMATIC_REGEX_MAP = /* @__PURE__ */ new Map([
	["(?i:'s|'t|'re|'ve|'m|'ll|'d)", "(?:'([sS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD]))"],
	["(?i:[sdmt]|ll|ve|re)", "(?:[sS]|[dD]|[mM]|[tT]|[lL][lL]|[vV][eE]|[rR][eE])"],
	["[^\\r\\n\\p{L}\\p{N}]?+", "[^\\r\\n\\p{L}\\p{N}]?"],
	["[^\\s\\p{L}\\p{N}]++", "[^\\s\\p{L}\\p{N}]+"],
	["(?>\\p{Nd}{510})", "(?:\\p{Nd}{510})"],
	["\\p{Nd}{3}+", "(?:\\p{Nd}{3})+"],
	["\\G", ""],
	[` ?[^(\\s|[${BLOOM_SPLIT_CHARS}])]+`, ` ?[^\\s${BLOOM_SPLIT_CHARS}]+`]
]);
var PUNCTUATION_REGEX = "\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E";
var clean_up_tokenization = (text) => text.replace(/ \./g, ".").replace(/ \?/g, "?").replace(/ \!/g, "!").replace(/ ,/g, ",").replace(/ \' /g, "'").replace(/ n't/g, "n't").replace(/ 'm/g, "'m").replace(/ 's/g, "'s").replace(/ 've/g, "'ve").replace(/ 're/g, "'re");
var create_pattern = (pattern, invert = true) => {
	if (pattern.Regex !== void 0) {
		let regex = pattern.Regex.replace(/\\([#&~])/g, "$1");
		regex = regex.replace(/\\A/g, "^").replace(/\\z/g, "$").replace(/\\Z/g, "(?=\\r?\\n?$)");
		for (const [key, value] of PROBLEMATIC_REGEX_MAP) regex = regex.replaceAll(key, value);
		try {
			return new RegExp(regex, "gu");
		} catch (error) {
			if (!(error instanceof SyntaxError) || !error.message.toLowerCase().includes("invalid property name")) throw error;
			let changed = false;
			const fixed = regex.replace(/(\\[pP])\{([^}=]+)\}/g, (_, p, n) => {
				try {
					new RegExp(`\\p{${n}}`, "u");
					return `${p}{${n}}`;
				} catch {
					changed = true;
					return `${p}{Script=${n}}`;
				}
			});
			if (!changed) throw error;
			try {
				return new RegExp(fixed, "gu");
			} catch (e) {
				throw error;
			}
		}
	} else if (pattern.String !== void 0) {
		const escaped = escape_reg_exp(pattern.String);
		return new RegExp(invert ? escaped : `(${escaped})`, "gu");
	} else {
		console.warn("Unknown pattern type:", pattern);
		return null;
	}
};
var escape_reg_exp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var fuse_unk = (arr, tokens_to_ids, unk_token_id) => {
	const fused = [];
	let i = 0;
	while (i < arr.length) {
		fused.push(arr[i]);
		if ((tokens_to_ids.get(arr[i]) ?? unk_token_id) !== unk_token_id) {
			++i;
			continue;
		}
		while (++i < arr.length && (tokens_to_ids.get(arr[i]) ?? unk_token_id) === unk_token_id) if (tokens_to_ids.get(fused.at(-1)) !== unk_token_id) fused[fused.length - 1] += arr[i];
	}
	return fused;
};
var is_chinese_char = (cp) => cp >= 19968 && cp <= 40959 || cp >= 13312 && cp <= 19903 || cp >= 131072 && cp <= 173791 || cp >= 173824 && cp <= 177983 || cp >= 177984 && cp <= 178207 || cp >= 178208 && cp <= 183983 || cp >= 63744 && cp <= 64255 || cp >= 194560 && cp <= 195103;
var is_integral_number = (x) => Number.isInteger(x) || typeof x === "bigint";
var len = (s) => {
	let length = 0;
	for (const c of s) ++length;
	return length;
};
var lowercase_and_remove_accents = (text) => remove_accents(text.toLowerCase());
var merge_arrays = (...arrs) => Array.prototype.concat.apply([], arrs);
var object_to_map = (obj) => new Map(Object.entries(obj));
var regex_split = (text, regex) => {
	const result = [];
	let prev = 0;
	for (const match of text.matchAll(regex)) {
		const full_match = match[0];
		if (prev < match.index) result.push(text.slice(prev, match.index));
		if (full_match.length > 0) result.push(full_match);
		prev = match.index + full_match.length;
	}
	if (prev < text.length) result.push(text.slice(prev));
	return result;
};
var remove_accents = (text) => text.replace(/\p{M}/gu, "");
var validate_object = (obj, name, required_keys = []) => {
	if (!obj || Array.isArray(obj) || typeof obj !== "object") return `${name} must be a valid object`;
	for (const key of required_keys) if (!(key in obj)) return `${name} must contain a "${key}" property`;
	return null;
};
var whitespace_split = (text) => text.match(/\S+/g) || [];
var Callable = class {
	/**
	* Creates a new instance of the Callable class.
	*/
	constructor() {
		const closure = function(...args) {
			return closure._call(...args);
		};
		return Object.setPrototypeOf(closure, new.target.prototype);
	}
};
var Callable_default = Callable;
var Normalizer = class extends Callable_default {
	/**
	* @param config The configuration object for the normalizer.
	*/
	constructor(config) {
		super();
		this.config = config;
	}
	/**
	* Alias for {@link Normalizer#normalize}.
	* @param text The text to normalize.
	* @returns The normalized text.
	*/
	_call(text) {
		return this.normalize(text);
	}
};
var Normalizer_default = Normalizer;
var BertNormalizer = class extends Normalizer_default {
	/**
	* Adds whitespace around any CJK (Chinese, Japanese, or Korean) character in the input text.
	*
	* @param text The input text to tokenize.
	* @returns The tokenized text with whitespace added around CJK characters.
	*/
	tokenize_chinese_chars(text) {
		const output = [];
		for (let i = 0; i < text.length; ++i) {
			const char = text[i];
			if (is_chinese_char(char.charCodeAt(0))) {
				output.push(" ");
				output.push(char);
				output.push(" ");
			} else output.push(char);
		}
		return output.join("");
	}
	/**
	* Strips accents from the given text.
	* @param text The text to strip accents from.
	* @returns The text with accents removed.
	*/
	strip_accents(text) {
		return text.normalize("NFD").replace(/\p{Mn}/gu, "");
	}
	/**
	* Checks whether `char` is a control character.
	* @param char The character to check.
	* @returns Whether `char` is a control character.
	*/
	is_control(char) {
		switch (char) {
			case "	":
			case "\n":
			case "\r": return false;
			default: return /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u.test(char);
		}
	}
	/**
	* Performs invalid character removal and whitespace cleanup on text.
	* @param text The text to clean.
	* @returns The cleaned text.
	*/
	clean_text(text) {
		const output = [];
		for (const char of text) {
			const cp = char.charCodeAt(0);
			if (cp === 0 || cp === 65533 || this.is_control(char)) continue;
			if (/^\s$/.test(char)) output.push(" ");
			else output.push(char);
		}
		return output.join("");
	}
	/**
	* Normalizes the given text based on the configuration.
	* @param text The text to normalize.
	* @returns The normalized text.
	*/
	normalize(text) {
		if (this.config.clean_text) text = this.clean_text(text);
		if (this.config.handle_chinese_chars) text = this.tokenize_chinese_chars(text);
		if (this.config.lowercase) {
			text = text.toLowerCase();
			if (this.config.strip_accents !== false) text = this.strip_accents(text);
		} else if (this.config.strip_accents) text = this.strip_accents(text);
		return text;
	}
};
var BertNormalizer_default = BertNormalizer;
var Precompiled = class extends Normalizer_default {
	/**
	* Create a new instance of Precompiled normalizer.
	* @param config The configuration object.
	*/
	constructor(config) {
		super(config);
		this.charsmap = config.precompiled_charsmap ?? null;
	}
	/**
	* Normalizes the given text by applying the precompiled charsmap.
	* @param text The text to normalize.
	* @returns The normalized text.
	*/
	normalize(text) {
		text = text.replace(/[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/gm, "");
		text = text.replace(/[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/gm, " ");
		if (text.includes("～")) text = text.split("～").map((part) => part.normalize("NFKC")).join("～");
		else text = text.normalize("NFKC");
		return text;
	}
};
var Precompiled_default = Precompiled;
var Sequence = class extends Normalizer_default {
	/**
	* Create a new instance of NormalizerSequence.
	* @param config The configuration object.
	*/
	constructor(config) {
		super(config);
		this.normalizers = (config.normalizers ?? []).map((x) => create_normalizer_default(x));
	}
	/**
	* Apply a sequence of Normalizers to the input text.
	* @param text The text to normalize.
	* @returns The normalized text.
	*/
	normalize(text) {
		return this.normalizers.reduce((t, normalizer) => {
			return normalizer ? normalizer.normalize(t) : t;
		}, text);
	}
};
var Sequence_default = Sequence;
var Replace = class extends Normalizer_default {
	/**
	* Normalize the input text by replacing the pattern with the content.
	* @param text The input text to be normalized.
	* @returns The normalized text after replacing the pattern with the content.
	*/
	normalize(text) {
		const pattern = create_pattern(this.config.pattern ?? {});
		return pattern === null ? text : text.replaceAll(pattern, this.config.content ?? "");
	}
};
var Replace_default = Replace;
var UnicodeNormalizer = class extends Normalizer_default {
	constructor() {
		super(...arguments);
		/**
		* The Unicode normalization form to apply.
		* Should be one of: 'NFC', 'NFD', 'NFKC', or 'NFKD'.
		*/
		this.form = "NFC";
	}
	/**
	* Normalize the input text by applying Unicode normalization.
	* @param text The input text to be normalized.
	* @returns The normalized text.
	*/
	normalize(text) {
		text = text.normalize(this.form);
		return text;
	}
};
var UnicodeNormalizer_default = UnicodeNormalizer;
var NFC = class extends UnicodeNormalizer_default {
	constructor() {
		super(...arguments);
		this.form = "NFC";
	}
};
var NFC_default = NFC;
var NFD = class extends UnicodeNormalizer_default {
	constructor() {
		super(...arguments);
		this.form = "NFD";
	}
};
var NFD_default = NFD;
var NFKC = class extends UnicodeNormalizer_default {
	constructor() {
		super(...arguments);
		this.form = "NFKC";
	}
};
var NFKC_default = NFKC;
var NFKD = class extends UnicodeNormalizer_default {
	constructor() {
		super(...arguments);
		this.form = "NFKD";
	}
};
var NFKD_default = NFKD;
var Strip = class extends Normalizer_default {
	/**
	* Strip leading and/or trailing whitespace from the input text.
	* @param text The input text.
	* @returns The normalized text.
	*/
	normalize(text) {
		if (this.config.strip_left && this.config.strip_right) text = text.trim();
		else {
			if (this.config.strip_left) text = text.trimStart();
			if (this.config.strip_right) text = text.trimEnd();
		}
		return text;
	}
};
var Strip_default = Strip;
var StripAccents = class extends Normalizer_default {
	/**
	* Remove all accents from the text.
	* @param text The input text.
	* @returns The normalized text without accents.
	*/
	normalize(text) {
		return remove_accents(text);
	}
};
var StripAccents_default = StripAccents;
var Lowercase = class extends Normalizer_default {
	/**
	* Lowercases the input string.
	* @param {string} text The text to normalize.
	* @returns {string} The normalized text.
	*/
	normalize(text) {
		return text.toLowerCase();
	}
};
var Lowercase_default = Lowercase;
var Prepend = class extends Normalizer_default {
	/**
	* Prepends the input string.
	* @param text The text to normalize.
	* @returns The normalized text.
	*/
	normalize(text) {
		text = this.config.prepend + text;
		return text;
	}
};
var Prepend_default = Prepend;
function create_normalizer(config) {
	if (config === null) return null;
	switch (config.type) {
		case "BertNormalizer": return new BertNormalizer_default(config);
		case "Precompiled": return new Precompiled_default(config);
		case "Sequence": return new Sequence_default(config);
		case "Replace": return new Replace_default(config);
		case "NFC": return new NFC_default(config);
		case "NFD": return new NFD_default(config);
		case "NFKC": return new NFKC_default(config);
		case "NFKD": return new NFKD_default(config);
		case "Strip": return new Strip_default(config);
		case "StripAccents": return new StripAccents_default(config);
		case "Lowercase": return new Lowercase_default(config);
		case "Prepend": return new Prepend_default(config);
		default: throw new Error(`Unknown Normalizer type: ${config.type}`);
	}
}
var create_normalizer_default = create_normalizer;
var PreTokenizer = class extends Callable_default {
	/**
	* Tokenizes the given text into pre-tokens.
	* @param text The text or array of texts to pre-tokenize.
	* @param options Additional options for the pre-tokenization logic.
	* @returns An array of pre-tokens.
	*/
	pre_tokenize(text, options) {
		return (Array.isArray(text) ? text.map((x) => this.pre_tokenize_text(x, options)) : this.pre_tokenize_text(text, options)).flat();
	}
	/**
	* Alias for {@link PreTokenizer#pre_tokenize}.
	* @param text The text or array of texts to pre-tokenize.
	* @param options Additional options for the pre-tokenization logic.
	* @returns An array of pre-tokens.
	*/
	_call(text, options) {
		return this.pre_tokenize(text, options);
	}
};
var PreTokenizer_default = PreTokenizer;
var ByteLevel = class extends PreTokenizer_default {
	/**
	* Creates a new instance of the `ByteLevelPreTokenizer` class.
	* @param config The configuration object.
	*/
	constructor(config) {
		super();
		this.config = config;
		this.add_prefix_space = this.config.add_prefix_space ?? false;
		this.trim_offsets = this.config.trim_offsets ?? false;
		this.use_regex = this.config.use_regex ?? true;
		this.pattern = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
		this.byte_encoder = BYTES_TO_UNICODE;
		this.text_encoder = new TextEncoder();
	}
	/**
	* Tokenizes a single piece of text using byte-level tokenization.
	* @param text The text to tokenize.
	* @param options Additional options for the pre-tokenization logic.
	* @returns An array of tokens.
	*/
	pre_tokenize_text(text, options) {
		if (this.add_prefix_space && !text.startsWith(" ")) text = " " + text;
		return (this.use_regex ? text.match(this.pattern) || [] : [text]).map((token) => Array.from(this.text_encoder.encode(token), (byte) => this.byte_encoder[byte]).join(""));
	}
};
var ByteLevel_default = ByteLevel;
var Whitespace = class extends PreTokenizer_default {
	/**
	* Pre-tokenizes the input text by splitting it on word boundaries.
	* @param text The text to be pre-tokenized.
	* @param options Additional options for the pre-tokenization logic.
	* @returns An array of tokens produced by splitting the input text on whitespace.
	*/
	pre_tokenize_text(text, options) {
		return text.match(/\w+|[^\w\s]+/g) || [];
	}
};
var Whitespace_default = Whitespace;
var Metaspace = class extends PreTokenizer_default {
	/**
	* @param config The configuration object for the MetaspacePreTokenizer.
	*/
	constructor(config) {
		super();
		this.replacement = config.replacement ?? "▁";
		this.str_rep = config.str_rep || this.replacement;
		this.prepend_scheme = config.prepend_scheme ?? "always";
	}
	/**
	* This method takes a string, replaces spaces with the replacement character,
	* adds a prefix space if requested, and returns a new list of tokens.
	* @param text The text to pre-tokenize.
	* @param options The options for the pre-tokenization.
	* @returns A new list of pre-tokenized tokens.
	*/
	pre_tokenize_text(text, options) {
		const { section_index = void 0 } = options ?? {};
		let normalized = text.replaceAll(" ", this.str_rep);
		if (!normalized.startsWith(this.replacement) && (this.prepend_scheme === "always" || this.prepend_scheme === "first" && section_index === 0)) normalized = this.str_rep + normalized;
		return [normalized];
	}
};
var Metaspace_default = Metaspace;
var Split = class extends PreTokenizer_default {
	/**
	* @param config The configuration options for the pre-tokenizer.
	*/
	constructor(config) {
		super();
		this.config = config;
		this.pattern = create_pattern(this.config.pattern ?? {}, this.config.invert ?? true);
	}
	/**
	* Tokenizes text by splitting it using the given pattern.
	* @param text The text to tokenize.
	* @returns An array of tokens.
	*/
	pre_tokenize_text(text) {
		if (this.pattern === null) return [];
		if (this.config.invert) return text.match(this.pattern) || [];
		else if (this.config.behavior?.toLowerCase() === "removed") return text.split(this.pattern).filter((x) => x);
		else return regex_split(text, this.pattern);
	}
};
var Split_default = Split;
var Punctuation = class extends PreTokenizer_default {
	/**
	* @param config The configuration options for the pre-tokenizer.
	*/
	constructor(config) {
		super();
		this.config = config;
		this.pattern = new RegExp(`[^${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]+`, "gu");
	}
	/**
	* Tokenizes text by splitting it using the given pattern.
	* @param text The text to tokenize.
	* @returns An array of tokens.
	*/
	pre_tokenize_text(text) {
		return text.match(this.pattern) || [];
	}
};
var Punctuation_default = Punctuation;
var Digits = class extends PreTokenizer_default {
	/**
	* @param config The configuration options for the pre-tokenizer.
	*/
	constructor(config) {
		super();
		this.config = config;
		const digit_pattern = `[^\\d]+|\\d${this.config.individual_digits ? "" : "+"}`;
		this.pattern = new RegExp(digit_pattern, "gu");
	}
	/**
	* Tokenizes text by splitting it using the given pattern.
	* @param text The text to tokenize.
	* @returns An array of tokens.
	*/
	pre_tokenize_text(text) {
		return text.match(this.pattern) || [];
	}
};
var Digits_default = Digits;
var BertPreTokenizer = class extends PreTokenizer_default {
	/**
	* A PreTokenizer that splits text into wordpieces using a basic tokenization scheme
	* similar to that used in the original implementation of BERT.
	*/
	constructor() {
		super();
		this.pattern = new RegExp(`[^\\s${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]`, "gu");
	}
	/**
	* Tokenizes a single text using the BERT pre-tokenization scheme.
	*
	* @param text The text to tokenize.
	* @param options Additional options for the pre-tokenization logic.
	* @returns An array of tokens.
	*/
	pre_tokenize_text(text, options) {
		return text.trim().match(this.pattern) || [];
	}
};
var BertPreTokenizer_default = BertPreTokenizer;
var Replace2 = class extends PreTokenizer_default {
	/**
	* @param config The configuration options for the pre-tokenizer.
	*/
	constructor(config) {
		super();
		this.config = config;
		this.pattern = create_pattern(this.config.pattern ?? {});
		this.content = this.config.content ?? "";
	}
	/**
	* Pre-tokenizes the input text by replacing certain characters.
	* @param text The text to be pre-tokenized.
	* @returns An array of tokens produced by replacing certain characters.
	*/
	pre_tokenize_text(text) {
		if (this.pattern === null) return [text];
		return [text.replaceAll(this.pattern, this.config.content ?? "")];
	}
};
var Replace_default2 = Replace2;
var Sequence2 = class extends PreTokenizer_default {
	/**
	* Creates an instance of PreTokenizerSequence.
	* @param config The configuration object for the pre-tokenizer sequence.
	*/
	constructor(config) {
		super();
		this.tokenizers = (config.pretokenizers ?? []).map((x) => create_pre_tokenizer_default(x));
	}
	/**
	* Applies each pre-tokenizer in the sequence to the input text in turn.
	* @param text The text to pre-tokenize.
	* @param options Additional options for the pre-tokenization logic.
	* @returns The pre-tokenized text.
	*/
	pre_tokenize_text(text, options) {
		return this.tokenizers.reduce((pre_tokenized_text, tokenizer) => {
			return tokenizer ? tokenizer.pre_tokenize(pre_tokenized_text, options) : pre_tokenized_text;
		}, [text]);
	}
};
var Sequence_default2 = Sequence2;
var WhitespaceSplit = class extends PreTokenizer_default {
	/**
	* Pre-tokenizes the input text by splitting it on whitespace characters.
	* @param text The text to be pre-tokenized.
	* @returns An array of tokens produced by splitting the input text on whitespace.
	*/
	pre_tokenize_text(text) {
		return whitespace_split(text);
	}
};
var WhitespaceSplit_default = WhitespaceSplit;
var FixedLength = class extends PreTokenizer_default {
	/**
	* @param config The configuration options for the pre-tokenizer.
	*/
	constructor(config) {
		super();
		this.config = config;
		this._length = config.length;
	}
	/**
	* Pre-tokenizes the input text by splitting it into fixed-length tokens.
	* @param text The text to be pre-tokenized.
	* @returns An array of tokens produced by splitting the input text into fixed-length tokens.
	*/
	pre_tokenize_text(text) {
		const tokens = [];
		for (let i = 0; i < text.length; i += this._length) tokens.push(text.slice(i, i + this._length));
		return tokens;
	}
};
var FixedLength_default = FixedLength;
function create_pre_tokenizer(config) {
	if (config === null) return null;
	switch (config.type) {
		case "BertPreTokenizer": return new BertPreTokenizer_default();
		case "Sequence": return new Sequence_default2(config);
		case "Whitespace": return new Whitespace_default();
		case "WhitespaceSplit": return new WhitespaceSplit_default();
		case "Metaspace": return new Metaspace_default(config);
		case "ByteLevel": return new ByteLevel_default(config);
		case "Split": return new Split_default(config);
		case "Punctuation": return new Punctuation_default(config);
		case "Digits": return new Digits_default(config);
		case "Replace": return new Replace_default2(config);
		case "FixedLength": return new FixedLength_default(config);
		default: throw new Error(`Unknown PreTokenizer type: ${config.type}`);
	}
}
var create_pre_tokenizer_default = create_pre_tokenizer;
var TokenizerModel = class extends Callable_default {
	/**
	* Creates a new instance of TokenizerModel.
	* @param config The configuration object for the TokenizerModel.
	*/
	constructor(config) {
		super();
		this.config = config;
		this.vocab = [];
		this.tokens_to_ids = /* @__PURE__ */ new Map();
		this.unk_token_id = void 0;
		this.unk_token = void 0;
		this.end_of_word_suffix = void 0;
		this.fuse_unk = this.config.fuse_unk ?? false;
	}
	/**
	* Internal function to call the TokenizerModel instance.
	* @param tokens The tokens to encode.
	* @returns The encoded tokens.
	*/
	_call(tokens) {
		let result = this.encode(tokens);
		if (this.fuse_unk) result = fuse_unk(result, this.tokens_to_ids, this.unk_token_id);
		return result;
	}
};
var TokenizerModel_default = TokenizerModel;
var WordPieceTokenizer = class extends TokenizerModel_default {
	/**
	* @param config The configuration object.
	*/
	constructor(config) {
		super(config);
		/** The maximum number of characters per word. */
		this.max_input_chars_per_word = 100;
		this.tokens_to_ids = object_to_map(config.vocab);
		this.unk_token_id = this.tokens_to_ids.get(config.unk_token);
		this.unk_token = config.unk_token;
		this.max_input_chars_per_word = config.max_input_chars_per_word ?? 100;
		this.vocab = new Array(this.tokens_to_ids.size);
		for (const [key, value] of this.tokens_to_ids) this.vocab[value] = key;
	}
	/**
	* Encodes an array of tokens using WordPiece encoding.
	* @param tokens The tokens to encode.
	* @returns An array of encoded tokens.
	*/
	encode(tokens) {
		const output_tokens = [];
		for (const token of tokens) {
			const chars = [...token];
			if (chars.length > this.max_input_chars_per_word) {
				output_tokens.push(this.unk_token);
				continue;
			}
			let is_unknown = false;
			let start = 0;
			const sub_tokens = [];
			while (start < chars.length) {
				let end = chars.length;
				let current_substring = null;
				while (start < end) {
					let substr = chars.slice(start, end).join("");
					if (start > 0) substr = this.config.continuing_subword_prefix + substr;
					if (this.tokens_to_ids.has(substr)) {
						current_substring = substr;
						break;
					}
					--end;
				}
				if (current_substring === null) {
					is_unknown = true;
					break;
				}
				sub_tokens.push(current_substring);
				start = end;
			}
			if (is_unknown) output_tokens.push(this.unk_token);
			else output_tokens.push(...sub_tokens);
		}
		return output_tokens;
	}
};
var WordPiece_default = WordPieceTokenizer;
var CharTrieNode = class _CharTrieNode {
	/**
	* Create a new CharTrieNode.
	* @param is_leaf Whether the node is a leaf node or not.
	* @param children A map containing the node's children, where the key is a character and the value is a `CharTrieNode`.
	*/
	constructor(is_leaf, children) {
		this.is_leaf = is_leaf;
		this.children = children;
	}
	/**
	* Returns a new `CharTrieNode` instance with default values.
	* @returns A new `CharTrieNode` instance with `is_leaf` set to `false` and an empty `children` map.
	*/
	static default() {
		return new _CharTrieNode(false, /* @__PURE__ */ new Map());
	}
};
var CharTrie = class {
	constructor() {
		this.root = CharTrieNode.default();
	}
	/**
	* Adds one or more `texts` to the trie.
	* @param texts The strings to add to the trie.
	*/
	extend(texts) {
		for (const text of texts) this.push(text);
	}
	/**
	* Adds text to the trie.
	* @param text The string to add to the trie.
	*/
	push(text) {
		let node = this.root;
		for (const ch of text) {
			let child = node.children.get(ch);
			if (child === void 0) {
				child = CharTrieNode.default();
				node.children.set(ch, child);
			}
			node = child;
		}
		node.is_leaf = true;
	}
	/**
	* Searches the trie for all strings with a common prefix of `text`.
	* @param text The common prefix to search for.
	* @yields Each string in the trie that has `text` as a prefix.
	*/
	*common_prefix_search(text) {
		let node = this.root;
		if (node === void 0) return;
		let prefix = "";
		for (const ch of text) {
			prefix += ch;
			node = node.children.get(ch);
			if (node === void 0) return;
			if (node.is_leaf) yield prefix;
		}
	}
};
var CharTrie_default = CharTrie;
var TokenLatticeNode = class _TokenLatticeNode {
	/**
	* Represents a node in a token lattice for a given sentence.
	* @param token_id The ID of the token associated with this node.
	* @param node_id The ID of this node.
	* @param pos The starting position of the token in the sentence.
	* @param length The length of the token.
	* @param score The score associated with the token.
	*/
	constructor(token_id, node_id, pos, length, score) {
		this.token_id = token_id;
		this.node_id = node_id;
		this.pos = pos;
		this.length = length;
		this.score = score;
		this.prev = null;
		this.backtrace_score = 0;
	}
	/**
	* Returns a clone of this node.
	* @returns A clone of this node.
	*/
	clone() {
		const n = new _TokenLatticeNode(this.token_id, this.node_id, this.pos, this.length, this.score);
		n.prev = this.prev;
		n.backtrace_score = this.backtrace_score;
		return n;
	}
};
var TokenLattice = class {
	/**
	* Creates a new TokenLattice instance.
	*
	* @param sentence The input sentence to be tokenized.
	* @param bos_token_id The beginning-of-sequence token ID.
	* @param eos_token_id The end-of-sequence token ID.
	*/
	constructor(sentence, bos_token_id, eos_token_id) {
		this.chars = Array.from(sentence);
		this.len = this.chars.length;
		this.bos_token_id = bos_token_id;
		this.eos_token_id = eos_token_id;
		this.nodes = [];
		this.begin_nodes = Array.from({ length: this.len + 1 }, () => []);
		this.end_nodes = Array.from({ length: this.len + 1 }, () => []);
		const bos = new TokenLatticeNode(this.bos_token_id ?? 0, 0, 0, 0, 0);
		const eos = new TokenLatticeNode(this.eos_token_id ?? 0, 1, this.len, 0, 0);
		this.nodes.push(bos.clone());
		this.nodes.push(eos.clone());
		this.begin_nodes[this.len].push(eos);
		this.end_nodes[0].push(bos);
	}
	/**
	* Inserts a new token node into the token lattice.
	*
	* @param pos The starting position of the token.
	* @param length The length of the token.
	* @param score The score of the token.
	* @param token_id The token ID of the token.
	*/
	insert(pos, length, score, token_id) {
		const node_id = this.nodes.length;
		const node = new TokenLatticeNode(token_id, node_id, pos, length, score);
		this.begin_nodes[pos].push(node);
		this.end_nodes[pos + length].push(node);
		this.nodes.push(node);
	}
	/**
	* Implements the Viterbi algorithm to compute the most likely sequence of tokens.
	*
	* @returns The most likely sequence of tokens.
	*/
	viterbi() {
		const len2 = this.len;
		let pos = 0;
		while (pos <= len2) {
			if (this.begin_nodes[pos].length == 0) return [];
			for (let rnode of this.begin_nodes[pos]) {
				rnode.prev = null;
				let best_score = 0;
				let best_node = null;
				for (let lnode of this.end_nodes[pos]) {
					const score = lnode.backtrace_score + rnode.score;
					if (best_node === null || score > best_score) {
						best_node = lnode.clone();
						best_score = score;
					}
				}
				if (best_node !== null) {
					rnode.prev = best_node;
					rnode.backtrace_score = best_score;
				} else return [];
			}
			++pos;
		}
		const results = [];
		const prev = this.begin_nodes[len2][0].prev;
		if (prev === null) return [];
		let node = prev.clone();
		while (node.prev !== null) {
			results.push(node.clone());
			node = node.clone().prev.clone();
		}
		results.reverse();
		return results;
	}
	/**
	* Get the text piece for a given node.
	* @param node The node to get the piece for.
	* @returns The array of nodes representing the most likely sequence of tokens.
	*/
	piece(node) {
		return this.chars.slice(node.pos, node.pos + node.length).join("");
	}
	/**
	* @returns The most likely sequence of tokens.
	*/
	tokens() {
		return this.viterbi().map((x) => this.piece(x));
	}
	/**
	* @returns The most likely sequence of token ids.
	*/
	token_ids() {
		return this.viterbi().map((x) => x.token_id);
	}
};
var TokenLattice_default = TokenLattice;
function min(arr) {
	if (arr.length === 0) throw new Error("Array must not be empty");
	let min_value = arr[0];
	let index_of_min = 0;
	for (let i = 1; i < arr.length; ++i) if (arr[i] < min_value) {
		min_value = arr[i];
		index_of_min = i;
	}
	return [min_value, index_of_min];
}
var Unigram = class extends TokenizerModel_default {
	/**
	* Create a new Unigram tokenizer model.
	* @param config The configuration object for the Unigram model.
	* @param eos_token
	*/
	constructor(config, eos_token) {
		super(config);
		const vocab_size = config.vocab.length;
		this.vocab = new Array(vocab_size);
		this.scores = new Array(vocab_size);
		for (let i = 0; i < vocab_size; ++i) [this.vocab[i], this.scores[i]] = config.vocab[i];
		this.unk_token_id = config.unk_id;
		this.unk_token = this.vocab[config.unk_id];
		this.tokens_to_ids = new Map(this.vocab.map((x, i) => [x, i]));
		this.bos_token = " ";
		this.bos_token_id = this.tokens_to_ids.get(this.bos_token);
		this.eos_token = eos_token;
		this.eos_token_id = this.tokens_to_ids.get(this.eos_token);
		this.unk_token = this.vocab[this.unk_token_id];
		this.min_score = min(this.scores)[0];
		this.unk_score = this.min_score - 10;
		this.scores[this.unk_token_id] = this.unk_score;
		this.trie = new CharTrie_default();
		this.trie.extend(this.vocab);
		this.fuse_unk = true;
	}
	/**
	* Populates lattice nodes.
	* @param lattice The token lattice to populate with nodes.
	*/
	populate_nodes(lattice) {
		const chars = lattice.chars;
		const mblen = 1;
		let begin_pos = 0;
		while (begin_pos < chars.length) {
			let has_single_node = false;
			const tokens = [];
			const sliced = chars.slice(begin_pos).join("");
			const prefixed_tokens = this.trie.common_prefix_search(sliced);
			for (const token of prefixed_tokens) {
				tokens.push(token);
				const token_id = this.tokens_to_ids.get(token);
				const token_score = this.scores[token_id];
				const n = len(token);
				lattice.insert(begin_pos, n, token_score, token_id);
				if (!has_single_node && n === mblen) has_single_node = true;
			}
			if (!has_single_node) lattice.insert(begin_pos, mblen, this.unk_score, this.unk_token_id);
			begin_pos += mblen;
		}
	}
	/**
	* Encodes an array of tokens into an array of subtokens using the unigram model.
	*
	* @param normalized The normalized string.
	* @returns An array of subtokens obtained by encoding the input tokens using the unigram model.
	*/
	tokenize(normalized) {
		const lattice = new TokenLattice_default(normalized, this.bos_token_id, this.eos_token_id);
		this.populate_nodes(lattice);
		return lattice.tokens();
	}
	/**
	* Encodes an array of tokens using Unigram encoding.
	* @param tokens The tokens to encode.
	* @returns An array of encoded tokens.
	*/
	encode(tokens) {
		const to_return = [];
		for (const token of tokens) {
			const tokenized = this.tokenize(token);
			to_return.push(...tokenized);
		}
		return to_return;
	}
};
var Unigram_default = Unigram;
var PriorityQueue = class {
	/**
	* Create a new PriorityQueue.
	* @param comparator Comparator function to determine priority. Defaults to a MaxHeap.
	* @param max_size Maximum size of the queue. Defaults to Infinity.
	*/
	constructor(comparator = (a, b) => a > b, max_size = Infinity) {
		this._heap = [];
		this._comparator = comparator;
		this._max_size = max_size;
	}
	/**
	* The size of the queue
	*/
	get size() {
		return this._heap.length;
	}
	/**
	* Check if the queue is empty.
	* @returns `true` if the queue is empty, `false` otherwise.
	*/
	is_empty() {
		return this.size === 0;
	}
	/**
	* Return the element with the highest priority in the queue.
	* @returns The highest priority element in the queue.
	*/
	peek() {
		return this._heap[0];
	}
	/**
	* Add one or more elements to the queue.
	* @param values The values to push into the queue.
	* @returns The new size of the queue.
	*/
	push(...values) {
		return this.extend(values);
	}
	/**
	* Add multiple elements to the queue.
	* @param values The values to push into the queue.
	* @returns The new size of the queue.
	*/
	extend(values) {
		for (const value of values) if (this.size < this._max_size) {
			this._heap.push(value);
			this._sift_up();
		} else {
			const smallest = this._smallest();
			if (this._comparator(value, this._heap[smallest])) {
				this._heap[smallest] = value;
				this._sift_up_from(smallest);
			}
		}
		return this.size;
	}
	/**
	* Remove and return the element with the highest priority in the queue.
	* @returns The element with the highest priority in the queue.
	*/
	pop() {
		const popped_value = this.peek();
		const bottom = this.size - 1;
		if (bottom > 0) this._swap(0, bottom);
		this._heap.pop();
		this._sift_down();
		return popped_value;
	}
	/**
	* Replace the element with the highest priority in the queue with a new value.
	* @param value The new value.
	* @returns The replaced value.
	*/
	replace(value) {
		const replaced_value = this.peek();
		this._heap[0] = value;
		this._sift_down();
		return replaced_value;
	}
	/**
	* Compute the index for the parent of the node at index `i`.
	* @param i The index of the node to get the parent of.
	* @returns The index of the parent node.
	* @private
	*/
	_parent(i) {
		return (i + 1 >>> 1) - 1;
	}
	/**
	* Compute the index for the left child of the node at index `i`.
	* @param i The index of the node to get the left child of.
	* @returns The index of the left child.
	* @private
	*/
	_left(i) {
		return (i << 1) + 1;
	}
	/**
	* Compute the index for the right child of the node at index `i`.
	* @param i The index of the node to get the right child of.
	* @returns The index of the right child.
	* @private
	*/
	_right(i) {
		return i + 1 << 1;
	}
	/**
	* Check if the element at index `i` is greater than the element at index `j`.
	* @param i The index of the first element to compare.
	* @param j The index of the second element to compare.
	* @returns `true` if the element at index `i` is greater than the element at index `j`, `false` otherwise.
	* @private
	*/
	_greater(i, j) {
		return this._comparator(this._heap[i], this._heap[j]);
	}
	/**
	* Swap the elements at indices `i` and `j`.
	* @param i The index of the first element to swap.
	* @param j The index of the second element to swap.
	* @private
	*/
	_swap(i, j) {
		const temp = this._heap[i];
		this._heap[i] = this._heap[j];
		this._heap[j] = temp;
	}
	/**
	* Maintain the heap property by updating positions in the heap,
	* starting at the last element and moving up the heap.
	* @private
	*/
	_sift_up() {
		this._sift_up_from(this.size - 1);
	}
	/**
	* Helper function to sift up from a given node.
	* @param node The index of the node to start sifting up from.
	*/
	_sift_up_from(node) {
		while (node > 0 && this._greater(node, this._parent(node))) {
			this._swap(node, this._parent(node));
			node = this._parent(node);
		}
	}
	/**
	* Maintain the heap property by updating positions in the heap,
	* starting at the first element and moving down the heap.
	* @private
	*/
	_sift_down() {
		let node = 0;
		while (this._left(node) < this.size && this._greater(this._left(node), node) || this._right(node) < this.size && this._greater(this._right(node), node)) {
			const max_child = this._right(node) < this.size && this._greater(this._right(node), this._left(node)) ? this._right(node) : this._left(node);
			this._swap(node, max_child);
			node = max_child;
		}
	}
	/**
	* Get the index of the smallest element in the heap. Since we use an array-based heap,
	* the index can be computed without needing to traverse the heap.
	* @private
	*/
	_smallest() {
		return 2 ** Math.floor(Math.log2(this.size)) - 1;
	}
};
var PriorityQueue_default = PriorityQueue;
var LRUCache = class {
	/**
	* Creates an LRUCache instance.
	* @param capacity The maximum number of items the cache can hold.
	*/
	constructor(capacity) {
		this.capacity = capacity;
		this.cache = /* @__PURE__ */ new Map();
	}
	/**
	* Retrieves the value associated with the given key and marks the key as recently used.
	* @param key The key to retrieve.
	* @returns The value associated with the key, or undefined if the key does not exist.
	*/
	get(key) {
		if (!this.cache.has(key)) return void 0;
		const value = this.cache.get(key);
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}
	/**
	* Inserts or updates the key-value pair in the cache.
	* If the key already exists, it is updated and marked as recently used.
	* If the cache exceeds its capacity, the least recently used item is evicted.
	* @param key The key to add or update.
	* @param value The value to associate with the key.
	*/
	put(key, value) {
		if (this.cache.has(key)) this.cache.delete(key);
		this.cache.set(key, value);
		if (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value);
	}
	/**
	* Clears the cache.
	*/
	clear() {
		this.cache.clear();
	}
};
var LRUCache_default = LRUCache;
var BPE = class extends TokenizerModel_default {
	/**
	* Create a BPE instance.
	* @param config The configuration object for BPE.
	*/
	constructor(config) {
		super(config);
		this.tokens_to_ids = object_to_map(config.vocab);
		this.unk_token_id = this.tokens_to_ids.get(config.unk_token);
		this.unk_token = config.unk_token;
		this.vocab = new Array(this.tokens_to_ids.size);
		for (const [key, value] of this.tokens_to_ids) this.vocab[value] = key;
		const use_new_merge_format = Array.isArray(config.merges[0]);
		this.merges = use_new_merge_format ? config.merges : config.merges.map((x) => x.split(" ", 2));
		this.bpe_ranks = new Map(this.merges.map((x, i) => [JSON.stringify(x), i]));
		this.end_of_word_suffix = config.end_of_word_suffix;
		this.continuing_subword_suffix = config.continuing_subword_suffix ?? null;
		this.byte_fallback = this.config.byte_fallback ?? false;
		if (this.byte_fallback) this.text_encoder = new TextEncoder();
		this.ignore_merges = this.config.ignore_merges ?? false;
		this.max_length_to_cache = 256;
		this.cache_capacity = 1e4;
		this.cache = new LRUCache_default(this.cache_capacity);
	}
	/**
	* Clears the cache.
	*/
	clear_cache() {
		this.cache.clear();
	}
	/**
	* Apply Byte-Pair-Encoding (BPE) to a given token. Efficient heap-based priority
	* queue implementation adapted from https://github.com/belladoreai/llama-tokenizer-js.
	* @param token The token to encode.
	* @returns The BPE encoded tokens.
	*/
	bpe(token) {
		if (token.length === 0) return [];
		const cached = this.cache.get(token);
		if (cached !== void 0) return cached;
		const word = Array.from(token);
		if (this.end_of_word_suffix) word[word.length - 1] += this.end_of_word_suffix;
		let result = [];
		if (word.length > 1) {
			const queue = new PriorityQueue_default((a, b) => a.score < b.score);
			let starting_node = {
				token: word[0],
				bias: 0,
				prev: null,
				next: null
			};
			let previous_node = starting_node;
			for (let i = 1; i < word.length; ++i) {
				const current_node = {
					bias: i / word.length,
					token: word[i],
					prev: previous_node,
					next: null
				};
				previous_node.next = current_node;
				this.add_node(queue, previous_node);
				previous_node = current_node;
			}
			while (!queue.is_empty()) {
				const node = queue.pop();
				if (node.deleted || !node.next || node.next.deleted) continue;
				node.deleted = true;
				node.next.deleted = true;
				if (node.prev) {
					const new_previous_node = { ...node.prev };
					node.prev.deleted = true;
					node.prev = new_previous_node;
					if (new_previous_node.prev) new_previous_node.prev.next = new_previous_node;
					else starting_node = new_previous_node;
				}
				const merged = {
					token: node.token + node.next.token,
					bias: node.bias,
					prev: node.prev,
					next: node.next.next
				};
				if (merged.prev) {
					merged.prev.next = merged;
					this.add_node(queue, merged.prev);
				} else starting_node = merged;
				if (merged.next) {
					merged.next.prev = merged;
					this.add_node(queue, merged);
				}
			}
			for (let current_node = starting_node; current_node !== null; current_node = current_node.next) result.push(current_node.token);
		} else result = word;
		if (this.continuing_subword_suffix) for (let i = 0; i < result.length - 1; ++i) result[i] += this.continuing_subword_suffix;
		if (token.length < this.max_length_to_cache) this.cache.put(token, result);
		return result;
	}
	/**
	* Helper function to add a node to the priority queue.
	* @param queue
	* @param node
	*/
	add_node(queue, node) {
		const rank = this.bpe_ranks.get(JSON.stringify([node.token, node.next.token]));
		if (rank !== void 0) {
			node.score = rank + node.bias;
			queue.push(node);
		}
	}
	/**
	* Encodes the input sequence of tokens using the BPE algorithm and returns the resulting subword tokens.
	* @param tokens The input sequence of tokens to encode.
	* @returns The resulting subword tokens after applying the BPE algorithm to the input sequence of tokens.
	*/
	encode(tokens) {
		const output_tokens = [];
		for (const token of tokens) {
			if (this.ignore_merges && this.tokens_to_ids.has(token)) {
				output_tokens.push(token);
				continue;
			}
			const bpe_token_list = this.bpe(token);
			for (const t of bpe_token_list) if (this.tokens_to_ids.has(t)) output_tokens.push(t);
			else if (this.byte_fallback) {
				const byte_tokens = Array.from(this.text_encoder.encode(t)).map((x) => `<0x${x.toString(16).toUpperCase().padStart(2, "0")}>`);
				if (byte_tokens.every((x) => this.tokens_to_ids.has(x))) output_tokens.push(...byte_tokens);
				else if (this.unk_token != null) output_tokens.push(this.unk_token);
			} else if (this.unk_token != null) output_tokens.push(this.unk_token);
		}
		return output_tokens;
	}
};
var BPE_default = BPE;
var Legacy = class extends TokenizerModel_default {
	/**
	* Create a Legacy tokenizer model instance.
	* @param config The configuration object for Legacy tokenizer model.
	* @param more_config Additional configuration object for the Legacy tokenizer model.
	*/
	constructor(config, more_config) {
		super(config);
		const vocab = config.vocab;
		this.tokens_to_ids = object_to_map(more_config.target_lang ? vocab[more_config.target_lang] : vocab);
		this.bos_token = more_config.bos_token;
		this.bos_token_id = this.tokens_to_ids.get(this.bos_token);
		this.eos_token = more_config.eos_token;
		this.eos_token_id = this.tokens_to_ids.get(this.eos_token);
		this.pad_token = more_config.pad_token;
		this.pad_token_id = this.tokens_to_ids.get(this.pad_token);
		this.unk_token = more_config.unk_token;
		this.unk_token_id = this.tokens_to_ids.get(this.unk_token);
		this.vocab = new Array(this.tokens_to_ids.size);
		for (const [key, value] of this.tokens_to_ids) this.vocab[value] = key;
	}
	encode(tokens) {
		return tokens;
	}
};
var Legacy_default = Legacy;
function create_tokenizer_model(model_config, config) {
	switch (model_config.type) {
		case "WordPiece": return new WordPiece_default(model_config);
		case "Unigram": return new Unigram_default(model_config, config.eos_token);
		case "BPE": return new BPE_default(model_config);
		default:
			if (model_config.vocab) if (Array.isArray(model_config.vocab)) return new Unigram_default(model_config, config.eos_token);
			else if (Object.hasOwn(model_config, "continuing_subword_prefix") && Object.hasOwn(model_config, "unk_token")) if (Object.hasOwn(model_config, "merges")) return new BPE_default(model_config);
			else return new WordPiece_default(model_config);
			else return new Legacy_default(model_config, {
				target_lang: config.target_lang,
				bos_token: config.bos_token,
				eos_token: config.eos_token,
				pad_token: config.pad_token,
				unk_token: config.unk_token
			});
			throw new Error(`Unknown TokenizerModel type: ${model_config?.type}`);
	}
}
var create_tokenizer_model_default = create_tokenizer_model;
var PostProcessor = class extends Callable_default {
	/**
	* @param config The configuration for the post-processor.
	*/
	constructor(config) {
		super();
		this.config = config;
	}
	/**
	* Alias for {@link PostProcessor#post_process}.
	* @param tokens The text or array of texts to post-process.
	* @param args Additional arguments required by the post-processing logic.
	* @returns The post-processed tokens.
	*/
	_call(tokens, ...args) {
		return this.post_process(tokens, ...args);
	}
};
var PostProcessor_default = PostProcessor;
var TemplateProcessing = class extends PostProcessor_default {
	/**
	* Replaces special tokens in the template with actual tokens.
	* @param tokens The list of tokens for the first sequence.
	* @param tokens_pair The list of tokens for the second sequence (optional).
	* @param add_special_tokens Whether to add the special tokens to the beginning and end of the input.
	* @returns An object containing the list of tokens with the special tokens replaced with actual tokens.
	*/
	post_process(tokens, tokens_pair = null, add_special_tokens = true) {
		const type = tokens_pair === null ? this.config.single : this.config.pair;
		let processed_tokens = [];
		let types = [];
		for (const item of type) if ("SpecialToken" in item) {
			if (add_special_tokens) {
				processed_tokens.push(item.SpecialToken.id);
				types.push(item.SpecialToken.type_id);
			}
		} else if ("Sequence" in item) {
			if (item.Sequence.id === "A") {
				processed_tokens = merge_arrays(processed_tokens, tokens);
				types = merge_arrays(types, new Array(tokens.length).fill(item.Sequence.type_id));
			} else if (item.Sequence.id === "B") {
				processed_tokens = merge_arrays(processed_tokens, tokens_pair);
				types = merge_arrays(types, new Array(tokens_pair.length).fill(item.Sequence.type_id));
			}
		}
		return {
			tokens: processed_tokens,
			token_type_ids: types
		};
	}
};
var TemplateProcessing_default = TemplateProcessing;
var ByteLevel2 = class extends PostProcessor_default {
	/**
	* Post process the given tokens.
	* @param tokens The list of tokens for the first sequence.
	* @param tokens_pair The list of tokens for the second sequence (optional).
	* @returns An object containing the post-processed tokens.
	*/
	post_process(tokens, tokens_pair = null) {
		return {
			tokens,
			tokens_pair
		};
	}
};
var ByteLevel_default2 = ByteLevel2;
var BertProcessing = class extends PostProcessor_default {
	/**
	* @param config The configuration for the post-processor.
	* @param config.cls The special tokens to add to the beginning of the input.
	* @param config.sep The special tokens to add to the end of the input.
	*/
	constructor(config) {
		super(config);
		this.sep = config.sep;
		this.cls = config.cls;
	}
	/**
	* Adds the special tokens to the beginning and end of the input.
	* @param tokens The input tokens.
	* @param tokens_pair An optional second set of input tokens.
	* @param add_special_tokens Whether to add the special tokens to the beginning and end of the input.
	* @returns The post-processed tokens with the special tokens added to the beginning and end.
	*/
	post_process(tokens, tokens_pair = null, add_special_tokens = true) {
		if (add_special_tokens) tokens = merge_arrays([this.cls[0]], tokens, [this.sep[0]]);
		let token_type_ids = new Array(tokens.length).fill(0);
		if (tokens_pair) {
			const middle = [];
			const after = add_special_tokens ? [this.sep[0]] : [];
			tokens = merge_arrays(tokens, middle, tokens_pair, after);
			token_type_ids = merge_arrays(token_type_ids, new Array(tokens_pair.length + middle.length + after.length).fill(1));
		}
		return {
			tokens,
			token_type_ids
		};
	}
};
var BertProcessing_default = BertProcessing;
var RobertaProcessing = class extends PostProcessor_default {
	/**
	* @param config The configuration for the post-processor.
	* @param config.cls The special tokens to add to the beginning of the input.
	* @param config.sep The special tokens to add to the end of the input.
	*/
	constructor(config) {
		super(config);
		this.sep = config.sep;
		this.cls = config.cls;
	}
	/**
	* Adds the special tokens to the beginning and end of the input.
	* @param tokens The input tokens.
	* @param tokens_pair An optional second set of input tokens.
	* @param add_special_tokens Whether to add the special tokens to the beginning and end of the input.
	* @returns The post-processed tokens with the special tokens added to the beginning and end.
	*/
	post_process(tokens, tokens_pair, add_special_tokens = true) {
		if (add_special_tokens) tokens = merge_arrays([this.cls[0]], tokens, [this.sep[0]]);
		let token_type_ids = new Array(tokens.length).fill(0);
		if (tokens_pair) {
			const middle = add_special_tokens ? [this.sep[0]] : [];
			const after = add_special_tokens ? [this.sep[0]] : [];
			tokens = merge_arrays(tokens, middle, tokens_pair, after);
			token_type_ids = merge_arrays(token_type_ids, new Array(tokens_pair.length + middle.length + after.length).fill(1));
		}
		return {
			tokens,
			token_type_ids
		};
	}
};
var RobertaProcessing_default = RobertaProcessing;
var Sequence3 = class extends PostProcessor_default {
	/**
	* Creates a new instance of Sequence post-processor.
	* @param config The configuration object.
	*/
	constructor(config) {
		super(config);
		this.processors = (config.processors ?? []).map((x) => create_post_processor_default(x));
	}
	/**
	* Post process the given tokens.
	* @param tokens The list of tokens for the first sequence.
	* @param tokens_pair The list of tokens for the second sequence (optional).
	* @param add_special_tokens Whether to add the special tokens to the beginning and end of the input.
	* @returns An object containing the post-processed tokens.
	*/
	post_process(tokens, tokens_pair = null, add_special_tokens = true) {
		let processed_tokens = {
			tokens,
			tokens_pair
		};
		for (const processor of this.processors) processed_tokens = processor.post_process(processed_tokens.tokens, processed_tokens.tokens_pair, add_special_tokens);
		return processed_tokens;
	}
};
var Sequence_default3 = Sequence3;
function create_post_processor(config) {
	if (config === null) return null;
	switch (config.type) {
		case "TemplateProcessing": return new TemplateProcessing_default(config);
		case "ByteLevel": return new ByteLevel_default2(config);
		case "BertProcessing": return new BertProcessing_default(config);
		case "RobertaProcessing": return new RobertaProcessing_default(config);
		case "Sequence": return new Sequence_default3(config);
		default: throw new Error(`Unknown PostProcessor type: ${config.type}`);
	}
}
var create_post_processor_default = create_post_processor;
var Decoder = class extends Callable_default {
	/**
	* Creates an instance of `Decoder`.
	* @param config The configuration object.
	**/
	constructor(config) {
		super();
		this.config = config;
		this.added_tokens = [];
		this.end_of_word_suffix = null;
		this.trim_offsets = "trim_offsets" in config ? config.trim_offsets : false;
	}
	/**
	* Calls the `decode` method.
	*
	* @param tokens The list of tokens.
	* @returns The decoded string.
	*/
	_call(tokens) {
		return this.decode(tokens);
	}
	/**
	* Decodes a list of tokens.
	* @param tokens The list of tokens.
	* @returns The decoded string.
	*/
	decode(tokens) {
		return this.decode_chain(tokens).join("");
	}
};
var Decoder_default = Decoder;
var ByteLevel3 = class extends Decoder_default {
	/**
	* Create a `ByteLevelDecoder` object.
	*/
	constructor(config) {
		super(config);
		this.byte_decoder = UNICODE_TO_BYTES;
		this.text_decoder = new TextDecoder("utf-8", {
			fatal: false,
			ignoreBOM: true
		});
		this.end_of_word_suffix = null;
	}
	/**
	* Convert an array of tokens to string by decoding each byte.
	* @param tokens Array of tokens to be decoded.
	* @returns The decoded string.
	*/
	convert_tokens_to_string(tokens) {
		const text = tokens.join("");
		const byte_array = new Uint8Array([...text].map((c) => this.byte_decoder[c]));
		return this.text_decoder.decode(byte_array);
	}
	decode_chain(tokens) {
		const sub_texts = [];
		let current_sub_text = [];
		for (const token of tokens) if (this.added_tokens.find((x) => x.content === token) !== void 0) {
			if (current_sub_text.length > 0) {
				sub_texts.push(this.convert_tokens_to_string(current_sub_text));
				current_sub_text = [];
			}
			sub_texts.push(token);
		} else current_sub_text.push(token);
		if (current_sub_text.length > 0) sub_texts.push(this.convert_tokens_to_string(current_sub_text));
		return sub_texts;
	}
};
var ByteLevel_default3 = ByteLevel3;
var WordPiece = class extends Decoder_default {
	/**
	* Creates a new instance of WordPieceDecoder.
	* @param config The configuration object.
	*/
	constructor(config) {
		super(config);
		this.cleanup = config.cleanup;
	}
	decode_chain(tokens) {
		return tokens.map((token, i) => {
			if (i !== 0) {
				const prefix = this.config.prefix;
				if (prefix && token.startsWith(prefix)) token = token.replace(prefix, "");
				else token = " " + token;
			}
			if (this.cleanup) token = clean_up_tokenization(token);
			return token;
		});
	}
};
var WordPiece_default2 = WordPiece;
var Metaspace2 = class extends Decoder_default {
	/**
	* Constructs a new MetaspaceDecoder object.
	* @param config The configuration object for the MetaspaceDecoder.
	*/
	constructor(config) {
		super(config);
		this.replacement = config.replacement ?? "▁";
	}
	decode_chain(tokens) {
		const result = [];
		for (let i = 0; i < tokens.length; ++i) {
			let normalized = tokens[i].replaceAll(this.replacement, " ");
			if (i == 0 && normalized.startsWith(" ")) normalized = normalized.substring(1);
			result.push(normalized);
		}
		return result;
	}
};
var Metaspace_default2 = Metaspace2;
var BPE2 = class extends Decoder_default {
	constructor(config) {
		super(config);
		this.suffix = config.suffix ?? "";
	}
	decode_chain(tokens) {
		return tokens.map((token, i) => {
			return token.replaceAll(this.suffix, i === tokens.length - 1 ? "" : " ");
		});
	}
};
var BPE_default2 = BPE2;
var CTC = class extends Decoder_default {
	constructor(config) {
		super(config);
		this.pad_token = config.pad_token ?? "";
		this.word_delimiter_token = config.word_delimiter_token ?? "";
		this.cleanup = config.cleanup;
	}
	/**
	* Converts a connectionist-temporal-classification (CTC) output tokens into a single string.
	* @param tokens Array of tokens to be decoded.
	* @returns The decoded string.
	*/
	convert_tokens_to_string(tokens) {
		if (tokens.length === 0) return "";
		const grouped_tokens = [tokens[0]];
		for (let i = 1; i < tokens.length; ++i) if (tokens[i] !== grouped_tokens.at(-1)) grouped_tokens.push(tokens[i]);
		let text = grouped_tokens.filter((token) => token !== this.pad_token).join("");
		if (this.cleanup) text = clean_up_tokenization(text).replaceAll(this.word_delimiter_token, " ").trim();
		return text;
	}
	decode_chain(tokens) {
		return [this.convert_tokens_to_string(tokens)];
	}
};
var CTC_default = CTC;
var Sequence4 = class extends Decoder_default {
	/**
	* Creates a new instance of DecoderSequence.
	* @param config The configuration object.
	*/
	constructor(config) {
		super(config);
		this.decoders = (config.decoders ?? []).map((x) => create_decoder_default(x));
	}
	decode_chain(tokens) {
		return this.decoders.reduce((toks, decoder) => {
			return decoder.decode_chain(toks);
		}, tokens);
	}
};
var Sequence_default4 = Sequence4;
var Replace3 = class extends Decoder_default {
	decode_chain(tokens) {
		const pattern = create_pattern(this.config.pattern);
		const content = this.config.content ?? "";
		return pattern === null ? tokens : tokens.map((token) => token.replaceAll(pattern, content));
	}
};
var Replace_default3 = Replace3;
var Fuse = class extends Decoder_default {
	decode_chain(tokens) {
		return [tokens.join("")];
	}
};
var Fuse_default = Fuse;
var Strip2 = class extends Decoder_default {
	constructor(config) {
		super(config);
		this.content = config.content ?? "";
		this.start = config.start ?? 0;
		this.stop = config.stop ?? 0;
	}
	decode_chain(tokens) {
		return tokens.map((token) => {
			let start_cut = 0;
			for (let i = 0; i < this.start; ++i) if (token[i] === this.content) {
				start_cut = i + 1;
				continue;
			} else break;
			let stop_cut = token.length;
			for (let i = 0; i < this.stop; ++i) {
				const index = token.length - i - 1;
				if (token[index] === this.content) {
					stop_cut = index;
					continue;
				} else break;
			}
			return token.slice(start_cut, stop_cut);
		});
	}
};
var Strip_default2 = Strip2;
var ByteFallback = class extends Decoder_default {
	constructor(config) {
		super(config);
		this.text_decoder = new TextDecoder();
	}
	decode_chain(tokens) {
		const new_tokens = [];
		let previous_byte_tokens = [];
		for (const token of tokens) {
			let bytes = null;
			if (token.length === 6 && token.startsWith("<0x") && token.endsWith(">")) {
				const byte = parseInt(token.slice(3, 5), 16);
				if (!isNaN(byte)) bytes = byte;
			}
			if (bytes !== null) previous_byte_tokens.push(bytes);
			else {
				if (previous_byte_tokens.length > 0) {
					const string = this.text_decoder.decode(Uint8Array.from(previous_byte_tokens));
					new_tokens.push(string);
					previous_byte_tokens = [];
				}
				new_tokens.push(token);
			}
		}
		if (previous_byte_tokens.length > 0) {
			const string = this.text_decoder.decode(Uint8Array.from(previous_byte_tokens));
			new_tokens.push(string);
			previous_byte_tokens = [];
		}
		return new_tokens;
	}
};
var ByteFallback_default = ByteFallback;
function create_decoder(config) {
	if (config === null) return null;
	switch (config.type) {
		case "ByteLevel": return new ByteLevel_default3(config);
		case "WordPiece": return new WordPiece_default2(config);
		case "Metaspace": return new Metaspace_default2(config);
		case "BPEDecoder": return new BPE_default2(config);
		case "CTC": return new CTC_default(config);
		case "Sequence": return new Sequence_default4(config);
		case "Replace": return new Replace_default3(config);
		case "Fuse": return new Fuse_default(config);
		case "Strip": return new Strip_default2(config);
		case "ByteFallback": return new ByteFallback_default(config);
		default: throw new Error(`Unknown Decoder type: ${config.type}`);
	}
}
var create_decoder_default = create_decoder;
var Tokenizer = class {
	constructor(tokenizer, config) {
		const tokenizer_error = validate_object(tokenizer, "Tokenizer", [
			"model",
			"decoder",
			"post_processor",
			"pre_tokenizer",
			"normalizer"
		]);
		if (tokenizer_error) throw new Error(tokenizer_error);
		const config_error = validate_object(config, "Config");
		if (config_error) throw new Error(config_error);
		this.tokenizer = tokenizer;
		this.config = config;
		this.normalizer = create_normalizer_default(this.tokenizer.normalizer);
		this.pre_tokenizer = create_pre_tokenizer_default(this.tokenizer.pre_tokenizer);
		this.model = create_tokenizer_model_default(this.tokenizer.model, this.config);
		this.post_processor = create_post_processor_default(this.tokenizer.post_processor);
		this.decoder = create_decoder_default(this.tokenizer.decoder);
		this.special_tokens = [];
		this.all_special_ids = [];
		this.added_tokens = [];
		const unnormalized_contents = [];
		const normalized_contents = [];
		this.added_tokens_map = /* @__PURE__ */ new Map();
		for (const added_token of this.tokenizer.added_tokens) {
			const token = new AddedToken_default(added_token);
			this.added_tokens.push(token);
			this.model.tokens_to_ids.set(token.content, token.id);
			this.model.vocab[token.id] = token.content;
			if (token.special) {
				this.special_tokens.push(token.content);
				this.all_special_ids.push(token.id);
			}
			this.added_tokens_map.set(token.content, token);
			if (token.normalized && this.normalizer !== null) {
				const normalized_content = this.normalizer(token.content);
				normalized_contents.push(normalized_content);
				this.added_tokens_map.set(normalized_content, token);
			} else unnormalized_contents.push(token.content);
		}
		(this.config.additional_special_tokens ?? []).forEach((token) => {
			if (!this.special_tokens.includes(token)) this.special_tokens.push(token);
		});
		if (this.decoder) {
			this.decoder.added_tokens = this.added_tokens;
			this.decoder.end_of_word_suffix = this.model.end_of_word_suffix;
		}
		this.splitter_unnormalized = new DictionarySplitter_default(unnormalized_contents);
		this.splitter_normalized = new DictionarySplitter_default(normalized_contents);
		this.remove_space = this.config.remove_space;
		this.clean_up_tokenization_spaces = this.config.clean_up_tokenization_spaces ?? true;
		this.do_lowercase_and_remove_accent = this.config.do_lowercase_and_remove_accent ?? false;
	}
	encode(text, { text_pair = null, add_special_tokens = true, return_token_type_ids = null } = {}) {
		const { tokens, token_type_ids } = this.tokenize_helper(text, {
			text_pair,
			add_special_tokens
		});
		const input_ids = tokens.map((t) => this.added_tokens_map.get(t)?.id ?? this.model.tokens_to_ids.get(t) ?? this.model.unk_token_id);
		const result = {
			ids: input_ids,
			tokens,
			attention_mask: new Array(input_ids.length).fill(1)
		};
		if (return_token_type_ids && token_type_ids) result.token_type_ids = token_type_ids;
		return result;
	}
	decode(token_ids, options = {}) {
		if (!Array.isArray(token_ids) || token_ids.length === 0 || !is_integral_number(token_ids[0])) throw Error("token_ids must be a non-empty array of integers.");
		let tokens = token_ids.map((i) => this.model.vocab[Number(i)] ?? this.model.unk_token);
		if (options.skip_special_tokens) tokens = tokens.filter((x) => !this.special_tokens.includes(x));
		let decoded = this.decoder ? this.decoder(tokens) : tokens.join(" ");
		if (this.decoder && this.decoder.end_of_word_suffix) {
			decoded = decoded.replaceAll(this.decoder.end_of_word_suffix, " ");
			if (options.skip_special_tokens) decoded = decoded.trim();
		}
		if (options.clean_up_tokenization_spaces ?? this.clean_up_tokenization_spaces) decoded = clean_up_tokenization(decoded);
		return decoded;
	}
	/**
	* Converts a string into a sequence of tokens.
	* @param text The sequence to be encoded.
	* @param options An optional object containing the following properties:
	* @returns The list of tokens.
	*/
	tokenize(text, { text_pair = null, add_special_tokens = false } = {}) {
		return this.tokenize_helper(text, {
			text_pair,
			add_special_tokens
		}).tokens;
	}
	encode_text(text) {
		if (text === null) return null;
		const sections = this.splitter_unnormalized.split(text);
		sections.forEach((section, i) => {
			const added_token = this.added_tokens_map.get(section);
			if (added_token) {
				if (added_token.lstrip && i > 0) sections[i - 1] = sections[i - 1].trimEnd();
				if (added_token.rstrip && i < sections.length - 1) sections[i + 1] = sections[i + 1].trimStart();
			}
		});
		return sections.flatMap((processed_text, section_index) => {
			if (processed_text.length === 0) return [];
			if (this.added_tokens_map.has(processed_text)) return [processed_text];
			if (this.remove_space === true) processed_text = processed_text.trim().split(/\s+/).join(" ");
			if (this.do_lowercase_and_remove_accent) processed_text = lowercase_and_remove_accents(processed_text);
			if (this.normalizer !== null) processed_text = this.normalizer(processed_text);
			if (processed_text.length === 0) return [];
			const subsections = this.splitter_normalized.split(processed_text);
			subsections.forEach((subsection, j) => {
				const added_token = this.added_tokens_map.get(subsection);
				if (added_token) {
					if (added_token.lstrip && j > 0) subsections[j - 1] = subsections[j - 1].trimEnd();
					if (added_token.rstrip && j < subsections.length - 1) subsections[j + 1] = subsections[j + 1].trimStart();
				}
			});
			return subsections.flatMap((subsection) => {
				if (subsection.length === 0) return [];
				if (this.added_tokens_map.has(subsection)) return [subsection];
				const section_tokens = this.pre_tokenizer !== null ? this.pre_tokenizer(subsection, { section_index }) : [subsection];
				return this.model(section_tokens);
			});
		});
	}
	tokenize_helper(text, { text_pair = null, add_special_tokens = true }) {
		const tokens1 = this.encode_text(text);
		const tokens2 = this.encode_text(text_pair || null);
		return this.post_processor ? this.post_processor(tokens1, tokens2, add_special_tokens) : { tokens: merge_arrays(tokens1 ?? [], tokens2 ?? []) };
	}
	/**
	* Converts a token string to its corresponding token ID.
	* @param token The token string to convert.
	* @returns The token ID, or undefined if the token is not in the vocabulary.
	*/
	token_to_id(token) {
		return this.model.tokens_to_ids.get(token);
	}
	/**
	* Converts a token ID to its corresponding token string.
	* @param id The token ID to convert.
	* @returns The token string, or undefined if the ID is not in the vocabulary.
	*/
	id_to_token(id) {
		return this.model.vocab[id];
	}
	/**
	* Returns a mapping of token IDs to AddedToken objects for all added tokens.
	* @returns A Map where keys are token IDs and values are AddedToken objects.
	*/
	get_added_tokens_decoder() {
		const decoder = /* @__PURE__ */ new Map();
		for (const token of this.added_tokens) decoder.set(token.id, token);
		return decoder;
	}
	/**
	* Get the underlying vocabulary
	* @param with_added_tokens Whether to include the added tokens
	* @returns The vocabulary
	*/
	get_vocab(with_added_tokens = true) {
		const vocab = /* @__PURE__ */ new Map();
		for (let i = 0; i < this.model.vocab.length; ++i) {
			const token = this.model.vocab[i];
			if (with_added_tokens || !this.added_tokens_map.has(token)) vocab.set(token, i);
		}
		return vocab;
	}
};
var Tokenizer_default = Tokenizer;
//#endregion
//#region node_modules/@huggingface/jinja/dist/index.js
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value
}) : obj[key] = value;
var __publicField = (obj, key, value) => {
	__defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
	return value;
};
var TOKEN_TYPES = Object.freeze({
	Text: "Text",
	NumericLiteral: "NumericLiteral",
	StringLiteral: "StringLiteral",
	Identifier: "Identifier",
	Equals: "Equals",
	OpenParen: "OpenParen",
	CloseParen: "CloseParen",
	OpenStatement: "OpenStatement",
	CloseStatement: "CloseStatement",
	OpenExpression: "OpenExpression",
	CloseExpression: "CloseExpression",
	OpenSquareBracket: "OpenSquareBracket",
	CloseSquareBracket: "CloseSquareBracket",
	OpenCurlyBracket: "OpenCurlyBracket",
	CloseCurlyBracket: "CloseCurlyBracket",
	Comma: "Comma",
	Dot: "Dot",
	Colon: "Colon",
	Pipe: "Pipe",
	CallOperator: "CallOperator",
	AdditiveBinaryOperator: "AdditiveBinaryOperator",
	MultiplicativeBinaryOperator: "MultiplicativeBinaryOperator",
	ComparisonBinaryOperator: "ComparisonBinaryOperator",
	UnaryOperator: "UnaryOperator",
	Comment: "Comment"
});
var Token = class {
	/**
	* Constructs a new Token.
	* @param {string} value The raw value as seen inside the source code.
	* @param {TokenType} type The type of token.
	*/
	constructor(value, type) {
		this.value = value;
		this.type = type;
	}
};
function isWord(char) {
	return /\w/.test(char);
}
function isInteger(char) {
	return /[0-9]/.test(char);
}
function isWhitespace(char) {
	return /\s/.test(char);
}
var ORDERED_MAPPING_TABLE = [
	["{%", TOKEN_TYPES.OpenStatement],
	["%}", TOKEN_TYPES.CloseStatement],
	["{{", TOKEN_TYPES.OpenExpression],
	["}}", TOKEN_TYPES.CloseExpression],
	["(", TOKEN_TYPES.OpenParen],
	[")", TOKEN_TYPES.CloseParen],
	["{", TOKEN_TYPES.OpenCurlyBracket],
	["}", TOKEN_TYPES.CloseCurlyBracket],
	["[", TOKEN_TYPES.OpenSquareBracket],
	["]", TOKEN_TYPES.CloseSquareBracket],
	[",", TOKEN_TYPES.Comma],
	[".", TOKEN_TYPES.Dot],
	[":", TOKEN_TYPES.Colon],
	["|", TOKEN_TYPES.Pipe],
	["<=", TOKEN_TYPES.ComparisonBinaryOperator],
	[">=", TOKEN_TYPES.ComparisonBinaryOperator],
	["==", TOKEN_TYPES.ComparisonBinaryOperator],
	["!=", TOKEN_TYPES.ComparisonBinaryOperator],
	["<", TOKEN_TYPES.ComparisonBinaryOperator],
	[">", TOKEN_TYPES.ComparisonBinaryOperator],
	["+", TOKEN_TYPES.AdditiveBinaryOperator],
	["-", TOKEN_TYPES.AdditiveBinaryOperator],
	["~", TOKEN_TYPES.AdditiveBinaryOperator],
	["*", TOKEN_TYPES.MultiplicativeBinaryOperator],
	["/", TOKEN_TYPES.MultiplicativeBinaryOperator],
	["%", TOKEN_TYPES.MultiplicativeBinaryOperator],
	["=", TOKEN_TYPES.Equals]
];
var ESCAPE_CHARACTERS = /* @__PURE__ */ new Map([
	["n", "\n"],
	["t", "	"],
	["r", "\r"],
	["b", "\b"],
	["f", "\f"],
	["v", "\v"],
	["'", "'"],
	["\"", "\""],
	["\\", "\\"]
]);
function preprocess(template, options = {}) {
	if (template.endsWith("\n")) template = template.slice(0, -1);
	if (options.lstrip_blocks) template = template.replace(/^[ \t]*({[#%-])/gm, "$1");
	if (options.trim_blocks) template = template.replace(/([#%-]})\n/g, "$1");
	return template.replace(/(\s*){%(-?)\s*(?:end)?generation\s*(-?)%}(\s*)/gs, (_, before, lstrip, rstrip, after) => (lstrip ? "" : before) + (rstrip ? "" : after));
}
function tokenize(source, options = {}) {
	const tokens = [];
	const src = preprocess(source, options);
	let cursorPosition = 0;
	let curlyBracketDepth = 0;
	const consumeWhile = (predicate) => {
		let str = "";
		while (predicate(src[cursorPosition])) {
			if (src[cursorPosition] === "\\") {
				++cursorPosition;
				if (cursorPosition >= src.length) throw new SyntaxError("Unexpected end of input");
				const escaped = src[cursorPosition++];
				const unescaped = ESCAPE_CHARACTERS.get(escaped);
				if (unescaped === void 0) throw new SyntaxError(`Unexpected escaped character: ${escaped}`);
				str += unescaped;
				continue;
			}
			str += src[cursorPosition++];
			if (cursorPosition >= src.length) throw new SyntaxError("Unexpected end of input");
		}
		return str;
	};
	const stripTrailingWhitespace = () => {
		const lastToken = tokens.at(-1);
		if (lastToken && lastToken.type === TOKEN_TYPES.Text) {
			lastToken.value = lastToken.value.trimEnd();
			if (lastToken.value === "") tokens.pop();
		}
	};
	const skipLeadingWhitespace = () => {
		while (cursorPosition < src.length && isWhitespace(src[cursorPosition])) ++cursorPosition;
	};
	main: while (cursorPosition < src.length) {
		const lastTokenType = tokens.at(-1)?.type;
		if (lastTokenType === void 0 || lastTokenType === TOKEN_TYPES.CloseStatement || lastTokenType === TOKEN_TYPES.CloseExpression || lastTokenType === TOKEN_TYPES.Comment) {
			let text = "";
			while (cursorPosition < src.length && !(src[cursorPosition] === "{" && (src[cursorPosition + 1] === "%" || src[cursorPosition + 1] === "{" || src[cursorPosition + 1] === "#"))) text += src[cursorPosition++];
			if (text.length > 0) {
				tokens.push(new Token(text, TOKEN_TYPES.Text));
				continue;
			}
		}
		if (src[cursorPosition] === "{" && src[cursorPosition + 1] === "#") {
			cursorPosition += 2;
			const stripBefore = src[cursorPosition] === "-";
			if (stripBefore) ++cursorPosition;
			let comment = "";
			while (src[cursorPosition] !== "#" || src[cursorPosition + 1] !== "}") {
				if (cursorPosition + 2 >= src.length) throw new SyntaxError("Missing end of comment tag");
				comment += src[cursorPosition++];
			}
			const stripAfter = comment.endsWith("-");
			if (stripAfter) comment = comment.slice(0, -1);
			if (stripBefore) stripTrailingWhitespace();
			tokens.push(new Token(comment, TOKEN_TYPES.Comment));
			cursorPosition += 2;
			if (stripAfter) skipLeadingWhitespace();
			continue;
		}
		if (src.slice(cursorPosition, cursorPosition + 3) === "{%-") {
			stripTrailingWhitespace();
			tokens.push(new Token("{%", TOKEN_TYPES.OpenStatement));
			cursorPosition += 3;
			continue;
		}
		if (src.slice(cursorPosition, cursorPosition + 3) === "{{-") {
			stripTrailingWhitespace();
			tokens.push(new Token("{{", TOKEN_TYPES.OpenExpression));
			curlyBracketDepth = 0;
			cursorPosition += 3;
			continue;
		}
		consumeWhile(isWhitespace);
		if (src.slice(cursorPosition, cursorPosition + 3) === "-%}") {
			tokens.push(new Token("%}", TOKEN_TYPES.CloseStatement));
			cursorPosition += 3;
			skipLeadingWhitespace();
			continue;
		}
		if (src.slice(cursorPosition, cursorPosition + 3) === "-}}") {
			tokens.push(new Token("}}", TOKEN_TYPES.CloseExpression));
			cursorPosition += 3;
			skipLeadingWhitespace();
			continue;
		}
		const char = src[cursorPosition];
		if (char === "-" || char === "+") {
			const lastTokenType2 = tokens.at(-1)?.type;
			if (lastTokenType2 === TOKEN_TYPES.Text || lastTokenType2 === void 0) throw new SyntaxError(`Unexpected character: ${char}`);
			switch (lastTokenType2) {
				case TOKEN_TYPES.Identifier:
				case TOKEN_TYPES.NumericLiteral:
				case TOKEN_TYPES.StringLiteral:
				case TOKEN_TYPES.CloseParen:
				case TOKEN_TYPES.CloseSquareBracket: break;
				default: {
					++cursorPosition;
					const num = consumeWhile(isInteger);
					tokens.push(new Token(`${char}${num}`, num.length > 0 ? TOKEN_TYPES.NumericLiteral : TOKEN_TYPES.UnaryOperator));
					continue;
				}
			}
		}
		for (const [seq, type] of ORDERED_MAPPING_TABLE) {
			if (seq === "}}" && curlyBracketDepth > 0) continue;
			if (src.slice(cursorPosition, cursorPosition + seq.length) === seq) {
				tokens.push(new Token(seq, type));
				if (type === TOKEN_TYPES.OpenExpression) curlyBracketDepth = 0;
				else if (type === TOKEN_TYPES.OpenCurlyBracket) ++curlyBracketDepth;
				else if (type === TOKEN_TYPES.CloseCurlyBracket) --curlyBracketDepth;
				cursorPosition += seq.length;
				continue main;
			}
		}
		if (char === "'" || char === "\"") {
			++cursorPosition;
			const str = consumeWhile((c) => c !== char);
			tokens.push(new Token(str, TOKEN_TYPES.StringLiteral));
			++cursorPosition;
			continue;
		}
		if (isInteger(char)) {
			let num = consumeWhile(isInteger);
			if (tokens.at(-1)?.type !== TOKEN_TYPES.Dot && src[cursorPosition] === "." && isInteger(src[cursorPosition + 1])) {
				++cursorPosition;
				const frac = consumeWhile(isInteger);
				num = `${num}.${frac}`;
			}
			tokens.push(new Token(num, TOKEN_TYPES.NumericLiteral));
			continue;
		}
		if (isWord(char)) {
			const word = consumeWhile(isWord);
			tokens.push(new Token(word, TOKEN_TYPES.Identifier));
			continue;
		}
		throw new SyntaxError(`Unexpected character: ${char}`);
	}
	return tokens;
}
var Statement = class {
	type = "Statement";
};
var Program = class extends Statement {
	constructor(body) {
		super();
		this.body = body;
	}
	type = "Program";
};
var If = class extends Statement {
	constructor(test, body, alternate) {
		super();
		this.test = test;
		this.body = body;
		this.alternate = alternate;
	}
	type = "If";
};
var For = class extends Statement {
	constructor(loopvar, iterable, body, defaultBlock) {
		super();
		this.loopvar = loopvar;
		this.iterable = iterable;
		this.body = body;
		this.defaultBlock = defaultBlock;
	}
	type = "For";
};
var Break = class extends Statement {
	type = "Break";
};
var Continue = class extends Statement {
	type = "Continue";
};
var SetStatement = class extends Statement {
	constructor(assignee, value, body) {
		super();
		this.assignee = assignee;
		this.value = value;
		this.body = body;
	}
	type = "Set";
};
var Macro = class extends Statement {
	constructor(name, args, body) {
		super();
		this.name = name;
		this.args = args;
		this.body = body;
	}
	type = "Macro";
};
var Comment = class extends Statement {
	constructor(value) {
		super();
		this.value = value;
	}
	type = "Comment";
};
var Expression = class extends Statement {
	type = "Expression";
};
var MemberExpression = class extends Expression {
	constructor(object, property, computed) {
		super();
		this.object = object;
		this.property = property;
		this.computed = computed;
	}
	type = "MemberExpression";
};
var CallExpression = class extends Expression {
	constructor(callee, args) {
		super();
		this.callee = callee;
		this.args = args;
	}
	type = "CallExpression";
};
var Identifier = class extends Expression {
	/**
	* @param {string} value The name of the identifier
	*/
	constructor(value) {
		super();
		this.value = value;
	}
	type = "Identifier";
};
var Literal = class extends Expression {
	constructor(value) {
		super();
		this.value = value;
	}
	type = "Literal";
};
var IntegerLiteral = class extends Literal {
	type = "IntegerLiteral";
};
var FloatLiteral = class extends Literal {
	type = "FloatLiteral";
};
var StringLiteral = class extends Literal {
	type = "StringLiteral";
};
var ArrayLiteral = class extends Literal {
	type = "ArrayLiteral";
};
var TupleLiteral = class extends Literal {
	type = "TupleLiteral";
};
var ObjectLiteral = class extends Literal {
	type = "ObjectLiteral";
};
var BinaryExpression = class extends Expression {
	constructor(operator, left, right) {
		super();
		this.operator = operator;
		this.left = left;
		this.right = right;
	}
	type = "BinaryExpression";
};
var FilterExpression = class extends Expression {
	constructor(operand, filter) {
		super();
		this.operand = operand;
		this.filter = filter;
	}
	type = "FilterExpression";
};
var FilterStatement = class extends Statement {
	constructor(filter, body) {
		super();
		this.filter = filter;
		this.body = body;
	}
	type = "FilterStatement";
};
var SelectExpression = class extends Expression {
	constructor(lhs, test) {
		super();
		this.lhs = lhs;
		this.test = test;
	}
	type = "SelectExpression";
};
var TestExpression = class extends Expression {
	constructor(operand, negate, test) {
		super();
		this.operand = operand;
		this.negate = negate;
		this.test = test;
	}
	type = "TestExpression";
};
var UnaryExpression = class extends Expression {
	constructor(operator, argument) {
		super();
		this.operator = operator;
		this.argument = argument;
	}
	type = "UnaryExpression";
};
var SliceExpression = class extends Expression {
	constructor(start = void 0, stop = void 0, step = void 0) {
		super();
		this.start = start;
		this.stop = stop;
		this.step = step;
	}
	type = "SliceExpression";
};
var KeywordArgumentExpression = class extends Expression {
	constructor(key, value) {
		super();
		this.key = key;
		this.value = value;
	}
	type = "KeywordArgumentExpression";
};
var SpreadExpression = class extends Expression {
	constructor(argument) {
		super();
		this.argument = argument;
	}
	type = "SpreadExpression";
};
var CallStatement = class extends Statement {
	constructor(call, callerArgs, body) {
		super();
		this.call = call;
		this.callerArgs = callerArgs;
		this.body = body;
	}
	type = "CallStatement";
};
var Ternary = class extends Expression {
	constructor(condition, trueExpr, falseExpr) {
		super();
		this.condition = condition;
		this.trueExpr = trueExpr;
		this.falseExpr = falseExpr;
	}
	type = "Ternary";
};
function parse(tokens) {
	const program = new Program([]);
	let current = 0;
	function expect(type, error) {
		const prev = tokens[current++];
		if (!prev || prev.type !== type) throw new Error(`Parser Error: ${error}. ${prev.type} !== ${type}.`);
		return prev;
	}
	function expectIdentifier(name) {
		if (!isIdentifier(name)) throw new SyntaxError(`Expected ${name}`);
		++current;
	}
	function parseAny() {
		switch (tokens[current].type) {
			case TOKEN_TYPES.Comment: return new Comment(tokens[current++].value);
			case TOKEN_TYPES.Text: return parseText();
			case TOKEN_TYPES.OpenStatement: return parseJinjaStatement();
			case TOKEN_TYPES.OpenExpression: return parseJinjaExpression();
			default: throw new SyntaxError(`Unexpected token type: ${tokens[current].type}`);
		}
	}
	function is(...types) {
		return current + types.length <= tokens.length && types.every((type, i) => type === tokens[current + i].type);
	}
	function isStatement(...names) {
		return tokens[current]?.type === TOKEN_TYPES.OpenStatement && tokens[current + 1]?.type === TOKEN_TYPES.Identifier && names.includes(tokens[current + 1]?.value);
	}
	function isIdentifier(...names) {
		return current + names.length <= tokens.length && names.every((name, i) => tokens[current + i].type === "Identifier" && name === tokens[current + i].value);
	}
	function parseText() {
		return new StringLiteral(expect(TOKEN_TYPES.Text, "Expected text token").value);
	}
	function parseJinjaStatement() {
		expect(TOKEN_TYPES.OpenStatement, "Expected opening statement token");
		if (tokens[current].type !== TOKEN_TYPES.Identifier) throw new SyntaxError(`Unknown statement, got ${tokens[current].type}`);
		const name = tokens[current].value;
		let result;
		switch (name) {
			case "set":
				++current;
				result = parseSetStatement();
				break;
			case "if":
				++current;
				result = parseIfStatement();
				expect(TOKEN_TYPES.OpenStatement, "Expected {% token");
				expectIdentifier("endif");
				expect(TOKEN_TYPES.CloseStatement, "Expected %} token");
				break;
			case "macro":
				++current;
				result = parseMacroStatement();
				expect(TOKEN_TYPES.OpenStatement, "Expected {% token");
				expectIdentifier("endmacro");
				expect(TOKEN_TYPES.CloseStatement, "Expected %} token");
				break;
			case "for":
				++current;
				result = parseForStatement();
				expect(TOKEN_TYPES.OpenStatement, "Expected {% token");
				expectIdentifier("endfor");
				expect(TOKEN_TYPES.CloseStatement, "Expected %} token");
				break;
			case "call": {
				++current;
				let callerArgs = null;
				if (is(TOKEN_TYPES.OpenParen)) callerArgs = parseArgs();
				const callee = parsePrimaryExpression();
				if (callee.type !== "Identifier") throw new SyntaxError(`Expected identifier following call statement`);
				const callArgs = parseArgs();
				expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
				const body = [];
				while (!isStatement("endcall")) body.push(parseAny());
				expect(TOKEN_TYPES.OpenStatement, "Expected '{%'");
				expectIdentifier("endcall");
				expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
				result = new CallStatement(new CallExpression(callee, callArgs), callerArgs, body);
				break;
			}
			case "break":
				++current;
				expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
				result = new Break();
				break;
			case "continue":
				++current;
				expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
				result = new Continue();
				break;
			case "filter": {
				++current;
				let filterNode = parsePrimaryExpression();
				if (filterNode instanceof Identifier && is(TOKEN_TYPES.OpenParen)) filterNode = parseCallExpression(filterNode);
				expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
				const filterBody = [];
				while (!isStatement("endfilter")) filterBody.push(parseAny());
				expect(TOKEN_TYPES.OpenStatement, "Expected '{%'");
				expectIdentifier("endfilter");
				expect(TOKEN_TYPES.CloseStatement, "Expected '%}'");
				result = new FilterStatement(filterNode, filterBody);
				break;
			}
			default: throw new SyntaxError(`Unknown statement type: ${name}`);
		}
		return result;
	}
	function parseJinjaExpression() {
		expect(TOKEN_TYPES.OpenExpression, "Expected opening expression token");
		const result = parseExpression();
		expect(TOKEN_TYPES.CloseExpression, "Expected closing expression token");
		return result;
	}
	function parseSetStatement() {
		const left = parseExpressionSequence();
		let value = null;
		const body = [];
		if (is(TOKEN_TYPES.Equals)) {
			++current;
			value = parseExpressionSequence();
		} else {
			expect(TOKEN_TYPES.CloseStatement, "Expected %} token");
			while (!isStatement("endset")) body.push(parseAny());
			expect(TOKEN_TYPES.OpenStatement, "Expected {% token");
			expectIdentifier("endset");
		}
		expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
		return new SetStatement(left, value, body);
	}
	function parseIfStatement() {
		const test = parseExpression();
		expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
		const body = [];
		const alternate = [];
		while (!isStatement("elif", "else", "endif")) body.push(parseAny());
		if (isStatement("elif")) {
			++current;
			++current;
			const result = parseIfStatement();
			alternate.push(result);
		} else if (isStatement("else")) {
			++current;
			++current;
			expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
			while (!isStatement("endif")) alternate.push(parseAny());
		}
		return new If(test, body, alternate);
	}
	function parseMacroStatement() {
		const name = parsePrimaryExpression();
		if (name.type !== "Identifier") throw new SyntaxError(`Expected identifier following macro statement`);
		const args = parseArgs();
		expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
		const body = [];
		while (!isStatement("endmacro")) body.push(parseAny());
		return new Macro(name, args, body);
	}
	function parseExpressionSequence(primary = false) {
		const fn = primary ? parsePrimaryExpression : parseExpression;
		const expressions = [fn()];
		const isTuple = is(TOKEN_TYPES.Comma);
		while (isTuple) {
			++current;
			expressions.push(fn());
			if (!is(TOKEN_TYPES.Comma)) break;
		}
		return isTuple ? new TupleLiteral(expressions) : expressions[0];
	}
	function parseForStatement() {
		const loopVariable = parseExpressionSequence(true);
		if (!(loopVariable instanceof Identifier || loopVariable instanceof TupleLiteral)) throw new SyntaxError(`Expected identifier/tuple for the loop variable, got ${loopVariable.type} instead`);
		if (!isIdentifier("in")) throw new SyntaxError("Expected `in` keyword following loop variable");
		++current;
		const iterable = parseExpression();
		expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
		const body = [];
		while (!isStatement("endfor", "else")) body.push(parseAny());
		const alternative = [];
		if (isStatement("else")) {
			++current;
			++current;
			expect(TOKEN_TYPES.CloseStatement, "Expected closing statement token");
			while (!isStatement("endfor")) alternative.push(parseAny());
		}
		return new For(loopVariable, iterable, body, alternative);
	}
	function parseExpression() {
		return parseIfExpression();
	}
	function parseIfExpression() {
		const a = parseLogicalOrExpression();
		if (isIdentifier("if")) {
			++current;
			const test = parseLogicalOrExpression();
			if (isIdentifier("else")) {
				++current;
				return new Ternary(test, a, parseIfExpression());
			} else return new SelectExpression(a, test);
		}
		return a;
	}
	function parseLogicalOrExpression() {
		let left = parseLogicalAndExpression();
		while (isIdentifier("or")) {
			const operator = tokens[current];
			++current;
			const right = parseLogicalAndExpression();
			left = new BinaryExpression(operator, left, right);
		}
		return left;
	}
	function parseLogicalAndExpression() {
		let left = parseLogicalNegationExpression();
		while (isIdentifier("and")) {
			const operator = tokens[current];
			++current;
			const right = parseLogicalNegationExpression();
			left = new BinaryExpression(operator, left, right);
		}
		return left;
	}
	function parseLogicalNegationExpression() {
		let right;
		while (isIdentifier("not")) {
			const operator = tokens[current];
			++current;
			right = new UnaryExpression(operator, parseLogicalNegationExpression());
		}
		return right ?? parseComparisonExpression();
	}
	function parseComparisonExpression() {
		let left = parseAdditiveExpression();
		while (true) {
			let operator;
			if (isIdentifier("not", "in")) {
				operator = new Token("not in", TOKEN_TYPES.Identifier);
				current += 2;
			} else if (isIdentifier("in")) operator = tokens[current++];
			else if (is(TOKEN_TYPES.ComparisonBinaryOperator)) operator = tokens[current++];
			else break;
			const right = parseAdditiveExpression();
			left = new BinaryExpression(operator, left, right);
		}
		return left;
	}
	function parseAdditiveExpression() {
		let left = parseMultiplicativeExpression();
		while (is(TOKEN_TYPES.AdditiveBinaryOperator)) {
			const operator = tokens[current];
			++current;
			const right = parseMultiplicativeExpression();
			left = new BinaryExpression(operator, left, right);
		}
		return left;
	}
	function parseCallMemberExpression() {
		const member = parseMemberExpression(parsePrimaryExpression());
		if (is(TOKEN_TYPES.OpenParen)) return parseCallExpression(member);
		return member;
	}
	function parseCallExpression(callee) {
		let expression = new CallExpression(callee, parseArgs());
		expression = parseMemberExpression(expression);
		if (is(TOKEN_TYPES.OpenParen)) expression = parseCallExpression(expression);
		return expression;
	}
	function parseArgs() {
		expect(TOKEN_TYPES.OpenParen, "Expected opening parenthesis for arguments list");
		const args = parseArgumentsList();
		expect(TOKEN_TYPES.CloseParen, "Expected closing parenthesis for arguments list");
		return args;
	}
	function parseArgumentsList() {
		const args = [];
		while (!is(TOKEN_TYPES.CloseParen)) {
			let argument;
			if (tokens[current].type === TOKEN_TYPES.MultiplicativeBinaryOperator && tokens[current].value === "*") {
				++current;
				argument = new SpreadExpression(parseExpression());
			} else {
				argument = parseExpression();
				if (is(TOKEN_TYPES.Equals)) {
					++current;
					if (!(argument instanceof Identifier)) throw new SyntaxError(`Expected identifier for keyword argument`);
					const value = parseExpression();
					argument = new KeywordArgumentExpression(argument, value);
				}
			}
			args.push(argument);
			if (is(TOKEN_TYPES.Comma)) ++current;
		}
		return args;
	}
	function parseMemberExpressionArgumentsList() {
		const slices = [];
		let isSlice = false;
		while (!is(TOKEN_TYPES.CloseSquareBracket)) if (is(TOKEN_TYPES.Colon)) {
			slices.push(void 0);
			++current;
			isSlice = true;
		} else {
			slices.push(parseExpression());
			if (is(TOKEN_TYPES.Colon)) {
				++current;
				isSlice = true;
			}
		}
		if (slices.length === 0) throw new SyntaxError(`Expected at least one argument for member/slice expression`);
		if (isSlice) {
			if (slices.length > 3) throw new SyntaxError(`Expected 0-3 arguments for slice expression`);
			return new SliceExpression(...slices);
		}
		return slices[0];
	}
	function parseMemberExpression(object) {
		while (is(TOKEN_TYPES.Dot) || is(TOKEN_TYPES.OpenSquareBracket)) {
			const operator = tokens[current];
			++current;
			let property;
			const computed = operator.type === TOKEN_TYPES.OpenSquareBracket;
			if (computed) {
				property = parseMemberExpressionArgumentsList();
				expect(TOKEN_TYPES.CloseSquareBracket, "Expected closing square bracket");
			} else {
				property = parsePrimaryExpression();
				if (property.type !== "Identifier" && property.type !== "IntegerLiteral") throw new SyntaxError(`Expected identifier or integer following dot operator`);
			}
			object = new MemberExpression(object, property, computed);
		}
		return object;
	}
	function parseMultiplicativeExpression() {
		let left = parseTestExpression();
		while (is(TOKEN_TYPES.MultiplicativeBinaryOperator)) {
			const operator = tokens[current++];
			const right = parseTestExpression();
			left = new BinaryExpression(operator, left, right);
		}
		return left;
	}
	function parseTestExpression() {
		let operand = parseFilterExpression();
		while (isIdentifier("is")) {
			++current;
			const negate = isIdentifier("not");
			if (negate) ++current;
			const filter = parsePrimaryExpression();
			if (!(filter instanceof Identifier)) throw new SyntaxError(`Expected identifier for the test`);
			operand = new TestExpression(operand, negate, filter);
		}
		return operand;
	}
	function parseFilterExpression() {
		let operand = parseCallMemberExpression();
		while (is(TOKEN_TYPES.Pipe)) {
			++current;
			let filter = parsePrimaryExpression();
			if (!(filter instanceof Identifier)) throw new SyntaxError(`Expected identifier for the filter`);
			if (is(TOKEN_TYPES.OpenParen)) filter = parseCallExpression(filter);
			operand = new FilterExpression(operand, filter);
		}
		return operand;
	}
	function parsePrimaryExpression() {
		const token = tokens[current++];
		switch (token.type) {
			case TOKEN_TYPES.NumericLiteral: {
				const num = token.value;
				return num.includes(".") ? new FloatLiteral(Number(num)) : new IntegerLiteral(Number(num));
			}
			case TOKEN_TYPES.StringLiteral: {
				let value = token.value;
				while (is(TOKEN_TYPES.StringLiteral)) value += tokens[current++].value;
				return new StringLiteral(value);
			}
			case TOKEN_TYPES.Identifier: return new Identifier(token.value);
			case TOKEN_TYPES.OpenParen: {
				const expression = parseExpressionSequence();
				expect(TOKEN_TYPES.CloseParen, "Expected closing parenthesis, got ${tokens[current].type} instead.");
				return expression;
			}
			case TOKEN_TYPES.OpenSquareBracket: {
				const values = [];
				while (!is(TOKEN_TYPES.CloseSquareBracket)) {
					values.push(parseExpression());
					if (is(TOKEN_TYPES.Comma)) ++current;
				}
				++current;
				return new ArrayLiteral(values);
			}
			case TOKEN_TYPES.OpenCurlyBracket: {
				const values = /* @__PURE__ */ new Map();
				while (!is(TOKEN_TYPES.CloseCurlyBracket)) {
					const key = parseExpression();
					expect(TOKEN_TYPES.Colon, "Expected colon between key and value in object literal");
					const value = parseExpression();
					values.set(key, value);
					if (is(TOKEN_TYPES.Comma)) ++current;
				}
				++current;
				return new ObjectLiteral(values);
			}
			default: throw new SyntaxError(`Unexpected token: ${token.type}`);
		}
	}
	while (current < tokens.length) program.body.push(parseAny());
	return program;
}
function range(start, stop, step = 1) {
	if (stop === void 0) {
		stop = start;
		start = 0;
	}
	if (step === 0) throw new Error("range() step must not be zero");
	const result = [];
	if (step > 0) for (let i = start; i < stop; i += step) result.push(i);
	else for (let i = start; i > stop; i += step) result.push(i);
	return result;
}
function slice(array, start, stop, step = 1) {
	const direction = Math.sign(step);
	if (direction >= 0) {
		start = (start ??= 0) < 0 ? Math.max(array.length + start, 0) : Math.min(start, array.length);
		stop = (stop ??= array.length) < 0 ? Math.max(array.length + stop, 0) : Math.min(stop, array.length);
	} else {
		start = (start ??= array.length - 1) < 0 ? Math.max(array.length + start, -1) : Math.min(start, array.length - 1);
		stop = (stop ??= -1) < -1 ? Math.max(array.length + stop, -1) : Math.min(stop, array.length - 1);
	}
	const result = [];
	for (let i = start; direction * i < direction * stop; i += step) result.push(array[i]);
	return result;
}
function titleCase(value) {
	return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
function strftime_now(format2) {
	return strftime(/* @__PURE__ */ new Date(), format2);
}
function strftime(date, format2) {
	const monthFormatterLong = new Intl.DateTimeFormat(void 0, { month: "long" });
	const monthFormatterShort = new Intl.DateTimeFormat(void 0, { month: "short" });
	const pad2 = (n) => n < 10 ? "0" + n : n.toString();
	return format2.replace(/%[YmdbBHM%]/g, (token) => {
		switch (token) {
			case "%Y": return date.getFullYear().toString();
			case "%m": return pad2(date.getMonth() + 1);
			case "%d": return pad2(date.getDate());
			case "%b": return monthFormatterShort.format(date);
			case "%B": return monthFormatterLong.format(date);
			case "%H": return pad2(date.getHours());
			case "%M": return pad2(date.getMinutes());
			case "%%": return "%";
			default: return token;
		}
	});
}
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function replace(str, oldvalue, newvalue, count) {
	if (count === 0) return str;
	let remaining = count == null || count < 0 ? Infinity : count;
	const pattern = oldvalue.length === 0 ? /* @__PURE__ */ new RegExp("(?=)", "gu") : new RegExp(escapeRegExp(oldvalue), "gu");
	return str.replaceAll(pattern, (match) => {
		if (remaining > 0) {
			--remaining;
			return newvalue;
		}
		return match;
	});
}
var BreakControl = class extends Error {};
var ContinueControl = class extends Error {};
var EMPTY_BUILTINS = /* @__PURE__ */ new Map();
var RuntimeValue = class {
	type = "RuntimeValue";
	value;
	/**
	* A collection of built-in functions for this type.
	*/
	get builtins() {
		return EMPTY_BUILTINS;
	}
	/**
	* Creates a new RuntimeValue.
	*/
	constructor(value = void 0) {
		this.value = value;
	}
	/**
	* Determines truthiness or falsiness of the runtime value.
	* This function should be overridden by subclasses if it has custom truthiness criteria.
	* @returns {BooleanValue} BooleanValue(true) if the value is truthy, BooleanValue(false) otherwise.
	*/
	__bool__() {
		return new BooleanValue(!!this.value);
	}
	toString() {
		return String(this.value);
	}
};
var IntegerValue = class extends RuntimeValue {
	type = "IntegerValue";
};
var FloatValue = class extends RuntimeValue {
	type = "FloatValue";
	toString() {
		return this.value % 1 === 0 ? this.value.toFixed(1) : this.value.toString();
	}
};
var StringValue = class extends RuntimeValue {
	type = "StringValue";
	_builtins;
	get builtins() {
		return this._builtins ??= /* @__PURE__ */ new Map([
			["upper", new FunctionValue(() => {
				return new StringValue(this.value.toUpperCase());
			})],
			["lower", new FunctionValue(() => {
				return new StringValue(this.value.toLowerCase());
			})],
			["strip", new FunctionValue(() => {
				return new StringValue(this.value.trim());
			})],
			["title", new FunctionValue(() => {
				return new StringValue(titleCase(this.value));
			})],
			["capitalize", new FunctionValue(() => {
				return new StringValue(this.value.charAt(0).toUpperCase() + this.value.slice(1));
			})],
			["length", new IntegerValue(this.value.length)],
			["rstrip", new FunctionValue(() => {
				return new StringValue(this.value.trimEnd());
			})],
			["lstrip", new FunctionValue(() => {
				return new StringValue(this.value.trimStart());
			})],
			["startswith", new FunctionValue((args) => {
				if (args.length === 0) throw new Error("startswith() requires at least one argument");
				const pattern = args[0];
				if (pattern instanceof StringValue) return new BooleanValue(this.value.startsWith(pattern.value));
				else if (pattern instanceof ArrayValue) {
					for (const item of pattern.value) {
						if (!(item instanceof StringValue)) throw new Error("startswith() tuple elements must be strings");
						if (this.value.startsWith(item.value)) return new BooleanValue(true);
					}
					return new BooleanValue(false);
				}
				throw new Error("startswith() argument must be a string or tuple of strings");
			})],
			["endswith", new FunctionValue((args) => {
				if (args.length === 0) throw new Error("endswith() requires at least one argument");
				const pattern = args[0];
				if (pattern instanceof StringValue) return new BooleanValue(this.value.endsWith(pattern.value));
				else if (pattern instanceof ArrayValue) {
					for (const item of pattern.value) {
						if (!(item instanceof StringValue)) throw new Error("endswith() tuple elements must be strings");
						if (this.value.endsWith(item.value)) return new BooleanValue(true);
					}
					return new BooleanValue(false);
				}
				throw new Error("endswith() argument must be a string or tuple of strings");
			})],
			["split", new FunctionValue((args) => {
				const sep = args[0] ?? new NullValue();
				if (!(sep instanceof StringValue || sep instanceof NullValue)) throw new Error("sep argument must be a string or null");
				const maxsplit = args[1] ?? new IntegerValue(-1);
				if (!(maxsplit instanceof IntegerValue)) throw new Error("maxsplit argument must be a number");
				let result = [];
				if (sep instanceof NullValue) {
					const text = this.value.trimStart();
					for (const { 0: match, index } of text.matchAll(/\S+/g)) {
						if (maxsplit.value !== -1 && result.length >= maxsplit.value && index !== void 0) {
							result.push(match + text.slice(index + match.length));
							break;
						}
						result.push(match);
					}
				} else {
					if (sep.value === "") throw new Error("empty separator");
					result = this.value.split(sep.value);
					if (maxsplit.value !== -1 && result.length > maxsplit.value) result.push(result.splice(maxsplit.value).join(sep.value));
				}
				return new ArrayValue(result.map((part) => new StringValue(part)));
			})],
			["replace", new FunctionValue((args) => {
				if (args.length < 2) throw new Error("replace() requires at least two arguments");
				const oldValue = args[0];
				const newValue = args[1];
				if (!(oldValue instanceof StringValue && newValue instanceof StringValue)) throw new Error("replace() arguments must be strings");
				let count;
				if (args.length > 2) if (args[2].type === "KeywordArgumentsValue") count = args[2].value.get("count") ?? new NullValue();
				else count = args[2];
				else count = new NullValue();
				if (!(count instanceof IntegerValue || count instanceof NullValue)) throw new Error("replace() count argument must be a number or null");
				return new StringValue(replace(this.value, oldValue.value, newValue.value, count.value));
			})]
		]);
	}
};
var BooleanValue = class extends RuntimeValue {
	type = "BooleanValue";
};
var NON_ASCII_CHARS = /[\x7f-\uffff]/g;
function makeAsciiSafe(str) {
	return str.replace(NON_ASCII_CHARS, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}
function toJSON(input, options = {}, depth = 0, convertUndefinedToNull = true) {
	const { indent = null, ensureAscii = false, separators = null, sortKeys = false } = options;
	let itemSeparator;
	let keySeparator;
	if (separators) [itemSeparator, keySeparator] = separators;
	else if (indent) {
		itemSeparator = ",";
		keySeparator = ": ";
	} else {
		itemSeparator = ", ";
		keySeparator = ": ";
	}
	switch (input.type) {
		case "NullValue": return "null";
		case "UndefinedValue": return convertUndefinedToNull ? "null" : "undefined";
		case "IntegerValue":
		case "FloatValue":
		case "BooleanValue": return JSON.stringify(input.value);
		case "StringValue": {
			let result = JSON.stringify(input.value);
			if (ensureAscii) result = makeAsciiSafe(result);
			return result;
		}
		case "ArrayValue":
		case "ObjectValue": {
			const indentValue = indent ? " ".repeat(indent) : "";
			const basePadding = "\n" + indentValue.repeat(depth);
			const childrenPadding = basePadding + indentValue;
			if (input.type === "ArrayValue") {
				const core = input.value.map((x) => toJSON(x, options, depth + 1, convertUndefinedToNull));
				return indent ? `[${childrenPadding}${core.join(`${itemSeparator}${childrenPadding}`)}${basePadding}]` : `[${core.join(itemSeparator)}]`;
			} else {
				let entries = Array.from(input.value.entries());
				if (sortKeys) entries = entries.sort(([a], [b]) => a.localeCompare(b));
				const core = entries.map(([key, value]) => {
					let keyStr = JSON.stringify(key);
					if (ensureAscii) keyStr = makeAsciiSafe(keyStr);
					const v = `${keyStr}${keySeparator}${toJSON(value, options, depth + 1, convertUndefinedToNull)}`;
					return indent ? `${childrenPadding}${v}` : v;
				});
				return indent ? `{${core.join(itemSeparator)}${basePadding}}` : `{${core.join(itemSeparator)}}`;
			}
		}
		default: throw new Error(`Cannot convert to JSON: ${input.type}`);
	}
}
var ObjectValue = class extends RuntimeValue {
	type = "ObjectValue";
	_builtins;
	/**
	* NOTE: necessary to override since all JavaScript arrays are considered truthy,
	* while only non-empty Python arrays are consider truthy.
	*
	* e.g.,
	*  - JavaScript:  {} && 5 -> 5
	*  - Python:      {} and 5 -> {}
	*/
	__bool__() {
		return new BooleanValue(this.value.size > 0);
	}
	get builtins() {
		return this._builtins ??= /* @__PURE__ */ new Map([
			["get", new FunctionValue(([key, defaultValue]) => {
				if (!(key instanceof StringValue)) throw new Error(`Object key must be a string: got ${key.type}`);
				return this.value.get(key.value) ?? defaultValue ?? new NullValue();
			})],
			["items", new FunctionValue(() => this.items())],
			["keys", new FunctionValue(() => this.keys())],
			["values", new FunctionValue(() => this.values())],
			["dictsort", new FunctionValue((args) => {
				let kwargs = /* @__PURE__ */ new Map();
				const positionalArgs = args.filter((arg) => {
					if (arg instanceof KeywordArgumentsValue) {
						kwargs = arg.value;
						return false;
					}
					return true;
				});
				const caseSensitive = positionalArgs.at(0) ?? kwargs.get("case_sensitive") ?? new BooleanValue(false);
				if (!(caseSensitive instanceof BooleanValue)) throw new Error("case_sensitive must be a boolean");
				const by = positionalArgs.at(1) ?? kwargs.get("by") ?? new StringValue("key");
				if (!(by instanceof StringValue)) throw new Error("by must be a string");
				if (!["key", "value"].includes(by.value)) throw new Error("by must be either 'key' or 'value'");
				const reverse = positionalArgs.at(2) ?? kwargs.get("reverse") ?? new BooleanValue(false);
				if (!(reverse instanceof BooleanValue)) throw new Error("reverse must be a boolean");
				return new ArrayValue(Array.from(this.value.entries()).map(([key, value]) => new ArrayValue([new StringValue(key), value])).sort((a, b) => {
					const index = by.value === "key" ? 0 : 1;
					const aVal = a.value[index];
					const bVal = b.value[index];
					const result = compareRuntimeValues(aVal, bVal, caseSensitive.value);
					return reverse.value ? -result : result;
				}));
			})]
		]);
	}
	items() {
		return new ArrayValue(Array.from(this.value.entries()).map(([key, value]) => new ArrayValue([new StringValue(key), value])));
	}
	keys() {
		return new ArrayValue(Array.from(this.value.keys()).map((key) => new StringValue(key)));
	}
	values() {
		return new ArrayValue(Array.from(this.value.values()));
	}
	toString() {
		return toJSON(this, {}, 0, false);
	}
};
var KeywordArgumentsValue = class extends ObjectValue {
	type = "KeywordArgumentsValue";
};
var ArrayValue = class extends RuntimeValue {
	type = "ArrayValue";
	_builtins;
	get builtins() {
		return this._builtins ??= /* @__PURE__ */ new Map([["length", new IntegerValue(this.value.length)]]);
	}
	/**
	* NOTE: necessary to override since all JavaScript arrays are considered truthy,
	* while only non-empty Python arrays are consider truthy.
	*
	* e.g.,
	*  - JavaScript:  [] && 5 -> 5
	*  - Python:      [] and 5 -> []
	*/
	__bool__() {
		return new BooleanValue(this.value.length > 0);
	}
	toString() {
		return toJSON(this, {}, 0, false);
	}
};
var TupleValue = class extends ArrayValue {
	type = "TupleValue";
};
var FunctionValue = class extends RuntimeValue {
	type = "FunctionValue";
};
var NullValue = class extends RuntimeValue {
	type = "NullValue";
};
var UndefinedValue = class extends RuntimeValue {
	type = "UndefinedValue";
};
var _Environment = class {
	constructor(parent) {
		this.parent = parent;
	}
	/**
	* The variables declared in this environment.
	*/
	variables = /* @__PURE__ */ new Map([["namespace", new FunctionValue((args) => {
		if (args.length === 0) return new ObjectValue(/* @__PURE__ */ new Map());
		if (args.length !== 1 || !(args[0] instanceof ObjectValue)) throw new Error("`namespace` expects either zero arguments or a single object argument");
		return args[0];
	})]]);
	tests = _Environment.TESTS;
	/**
	* Set the value of a variable in the current environment.
	*/
	set(name, value) {
		return this.declareVariable(name, convertToRuntimeValues(value));
	}
	declareVariable(name, value) {
		if (this.variables.has(name)) throw new SyntaxError(`Variable already declared: ${name}`);
		this.variables.set(name, value);
		return value;
	}
	/**
	* Set variable in the current scope.
	* See https://jinja.palletsprojects.com/en/3.0.x/templates/#assignments for more information.
	*/
	setVariable(name, value) {
		this.variables.set(name, value);
		return value;
	}
	/**
	* Resolve the environment in which the variable is declared.
	* @param {string} name The name of the variable.
	* @returns {Environment} The environment in which the variable is declared.
	*/
	resolve(name) {
		if (this.variables.has(name)) return this;
		if (this.parent) return this.parent.resolve(name);
		throw new Error(`Unknown variable: ${name}`);
	}
	lookupVariable(name) {
		try {
			return this.resolve(name).variables.get(name) ?? new UndefinedValue();
		} catch {
			return new UndefinedValue();
		}
	}
};
var Environment = _Environment;
/**
* The tests available in this environment.
*/
__publicField(Environment, "TESTS", /* @__PURE__ */ new Map([
	["boolean", (operand) => operand.type === "BooleanValue"],
	["callable", (operand) => operand instanceof FunctionValue],
	["odd", (operand) => {
		if (!(operand instanceof IntegerValue)) throw new Error(`cannot odd on ${operand.type}`);
		return operand.value % 2 !== 0;
	}],
	["even", (operand) => {
		if (!(operand instanceof IntegerValue)) throw new Error(`cannot even on ${operand.type}`);
		return operand.value % 2 === 0;
	}],
	["false", (operand) => operand.type === "BooleanValue" && !operand.value],
	["true", (operand) => operand.type === "BooleanValue" && operand.value],
	["none", (operand) => operand.type === "NullValue"],
	["string", (operand) => operand.type === "StringValue"],
	["number", (operand) => operand instanceof IntegerValue || operand instanceof FloatValue],
	["integer", (operand) => operand instanceof IntegerValue],
	["iterable", (operand) => operand.type === "ArrayValue" || operand.type === "StringValue"],
	["mapping", (operand) => operand instanceof ObjectValue],
	["sequence", (operand) => operand instanceof ArrayValue || operand instanceof ObjectValue || operand instanceof StringValue],
	["lower", (operand) => {
		const str = operand.value;
		return operand.type === "StringValue" && str === str.toLowerCase();
	}],
	["upper", (operand) => {
		const str = operand.value;
		return operand.type === "StringValue" && str === str.toUpperCase();
	}],
	["none", (operand) => operand.type === "NullValue"],
	["defined", (operand) => operand.type !== "UndefinedValue"],
	["undefined", (operand) => operand.type === "UndefinedValue"],
	["equalto", (a, b) => a.value === b.value],
	["eq", (a, b) => a.value === b.value]
]));
function setupGlobals(env) {
	env.set("false", false);
	env.set("true", true);
	env.set("none", null);
	env.set("raise_exception", (args) => {
		throw new Error(args);
	});
	env.set("range", range);
	env.set("strftime_now", strftime_now);
	env.set("True", true);
	env.set("False", false);
	env.set("None", null);
}
function getAttributeValue(item, attributePath) {
	const parts = attributePath.split(".");
	let value = item;
	for (const part of parts) if (value instanceof ObjectValue) value = value.value.get(part) ?? new UndefinedValue();
	else if (value instanceof ArrayValue) {
		const index = parseInt(part, 10);
		if (!isNaN(index) && index >= 0 && index < value.value.length) value = value.value[index];
		else return new UndefinedValue();
	} else return new UndefinedValue();
	return value;
}
function compareRuntimeValues(a, b, caseSensitive = false) {
	if (a instanceof NullValue && b instanceof NullValue) return 0;
	if (a instanceof NullValue || b instanceof NullValue) throw new Error(`Cannot compare ${a.type} with ${b.type}`);
	if (a instanceof UndefinedValue && b instanceof UndefinedValue) return 0;
	if (a instanceof UndefinedValue || b instanceof UndefinedValue) throw new Error(`Cannot compare ${a.type} with ${b.type}`);
	const isNumericLike = (v) => v instanceof IntegerValue || v instanceof FloatValue || v instanceof BooleanValue;
	const getNumericValue = (v) => {
		if (v instanceof BooleanValue) return v.value ? 1 : 0;
		return v.value;
	};
	if (isNumericLike(a) && isNumericLike(b)) {
		const aNum = getNumericValue(a);
		const bNum = getNumericValue(b);
		return aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
	}
	if (a.type !== b.type) throw new Error(`Cannot compare different types: ${a.type} and ${b.type}`);
	switch (a.type) {
		case "StringValue": {
			let aStr = a.value;
			let bStr = b.value;
			if (!caseSensitive) {
				aStr = aStr.toLowerCase();
				bStr = bStr.toLowerCase();
			}
			return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
		}
		default: throw new Error(`Cannot compare type: ${a.type}`);
	}
}
var Interpreter = class {
	global;
	constructor(env) {
		this.global = env ?? new Environment();
	}
	/**
	* Run the program.
	*/
	run(program) {
		return this.evaluate(program, this.global);
	}
	/**
	* Evaluates expressions following the binary operation type.
	*/
	evaluateBinaryExpression(node, environment) {
		const left = this.evaluate(node.left, environment);
		switch (node.operator.value) {
			case "and": return left.__bool__().value ? this.evaluate(node.right, environment) : left;
			case "or": return left.__bool__().value ? left : this.evaluate(node.right, environment);
		}
		const right = this.evaluate(node.right, environment);
		switch (node.operator.value) {
			case "==": return new BooleanValue(left.value == right.value);
			case "!=": return new BooleanValue(left.value != right.value);
		}
		if (left instanceof UndefinedValue || right instanceof UndefinedValue) {
			if (right instanceof UndefinedValue && ["in", "not in"].includes(node.operator.value)) return new BooleanValue(node.operator.value === "not in");
			throw new Error(`Cannot perform operation ${node.operator.value} on undefined values`);
		} else if (left instanceof NullValue || right instanceof NullValue) throw new Error("Cannot perform operation on null values");
		else if (node.operator.value === "~") return new StringValue(left.value.toString() + right.value.toString());
		else if ((left instanceof IntegerValue || left instanceof FloatValue) && (right instanceof IntegerValue || right instanceof FloatValue)) {
			const a = left.value, b = right.value;
			switch (node.operator.value) {
				case "+":
				case "-":
				case "*": {
					const res = node.operator.value === "+" ? a + b : node.operator.value === "-" ? a - b : a * b;
					return left instanceof FloatValue || right instanceof FloatValue ? new FloatValue(res) : new IntegerValue(res);
				}
				case "/": return new FloatValue(a / b);
				case "%": {
					const rem = a % b;
					return left instanceof FloatValue || right instanceof FloatValue ? new FloatValue(rem) : new IntegerValue(rem);
				}
				case "<": return new BooleanValue(a < b);
				case ">": return new BooleanValue(a > b);
				case ">=": return new BooleanValue(a >= b);
				case "<=": return new BooleanValue(a <= b);
			}
		} else if (left instanceof ArrayValue && right instanceof ArrayValue) switch (node.operator.value) {
			case "+": return new ArrayValue(left.value.concat(right.value));
		}
		else if (right instanceof ArrayValue) {
			const member = right.value.find((x) => x.value === left.value) !== void 0;
			switch (node.operator.value) {
				case "in": return new BooleanValue(member);
				case "not in": return new BooleanValue(!member);
			}
		}
		if (left instanceof StringValue || right instanceof StringValue) switch (node.operator.value) {
			case "+": return new StringValue(left.value.toString() + right.value.toString());
		}
		if (left instanceof StringValue && right instanceof StringValue) switch (node.operator.value) {
			case "in": return new BooleanValue(right.value.includes(left.value));
			case "not in": return new BooleanValue(!right.value.includes(left.value));
		}
		if (left instanceof StringValue && right instanceof ObjectValue) switch (node.operator.value) {
			case "in": return new BooleanValue(right.value.has(left.value));
			case "not in": return new BooleanValue(!right.value.has(left.value));
		}
		throw new SyntaxError(`Unknown operator "${node.operator.value}" between ${left.type} and ${right.type}`);
	}
	evaluateArguments(args, environment) {
		const positionalArguments = [];
		const keywordArguments = /* @__PURE__ */ new Map();
		for (const argument of args) if (argument.type === "SpreadExpression") {
			const spreadNode = argument;
			const val = this.evaluate(spreadNode.argument, environment);
			if (!(val instanceof ArrayValue)) throw new Error(`Cannot unpack non-iterable type: ${val.type}`);
			for (const item of val.value) positionalArguments.push(item);
		} else if (argument.type === "KeywordArgumentExpression") {
			const kwarg = argument;
			keywordArguments.set(kwarg.key.value, this.evaluate(kwarg.value, environment));
		} else {
			if (keywordArguments.size > 0) throw new Error("Positional arguments must come before keyword arguments");
			positionalArguments.push(this.evaluate(argument, environment));
		}
		return [positionalArguments, keywordArguments];
	}
	applyFilter(operand, filterNode, environment) {
		if (filterNode.type === "Identifier") {
			const filter = filterNode;
			if (filter.value === "safe") return operand;
			if (filter.value === "tojson") return new StringValue(toJSON(operand, {}));
			if (operand instanceof ArrayValue) switch (filter.value) {
				case "list": return operand;
				case "first": return operand.value[0];
				case "last": return operand.value[operand.value.length - 1];
				case "length": return new IntegerValue(operand.value.length);
				case "reverse": return new ArrayValue(operand.value.slice().reverse());
				case "sort": return new ArrayValue(operand.value.slice().sort((a, b) => compareRuntimeValues(a, b, false)));
				case "join": return new StringValue(operand.value.map((x) => x.value).join(""));
				case "string": return new StringValue(toJSON(operand, {}, 0, false));
				case "unique": {
					const seen = /* @__PURE__ */ new Set();
					const output = [];
					for (const item of operand.value) if (!seen.has(item.value)) {
						seen.add(item.value);
						output.push(item);
					}
					return new ArrayValue(output);
				}
				default: throw new Error(`Unknown ArrayValue filter: ${filter.value}`);
			}
			else if (operand instanceof StringValue) switch (filter.value) {
				case "length":
				case "upper":
				case "lower":
				case "title":
				case "capitalize": {
					const builtin = operand.builtins.get(filter.value);
					if (builtin instanceof FunctionValue) return builtin.value([], environment);
					else if (builtin instanceof IntegerValue) return builtin;
					else throw new Error(`Unknown StringValue filter: ${filter.value}`);
				}
				case "trim": return new StringValue(operand.value.trim());
				case "indent": return new StringValue(operand.value.split("\n").map((x, i) => i === 0 || x.length === 0 ? x : "    " + x).join("\n"));
				case "join":
				case "string": return operand;
				case "int": {
					const val = parseInt(operand.value, 10);
					return new IntegerValue(isNaN(val) ? 0 : val);
				}
				case "float": {
					const val = parseFloat(operand.value);
					return new FloatValue(isNaN(val) ? 0 : val);
				}
				default: throw new Error(`Unknown StringValue filter: ${filter.value}`);
			}
			else if (operand instanceof IntegerValue || operand instanceof FloatValue) switch (filter.value) {
				case "abs": return operand instanceof IntegerValue ? new IntegerValue(Math.abs(operand.value)) : new FloatValue(Math.abs(operand.value));
				case "int": return new IntegerValue(Math.floor(operand.value));
				case "float": return new FloatValue(operand.value);
				case "string": return new StringValue(operand.toString());
				default: throw new Error(`Unknown NumericValue filter: ${filter.value}`);
			}
			else if (operand instanceof ObjectValue) switch (filter.value) {
				case "items": return new ArrayValue(Array.from(operand.value.entries()).map(([key, value]) => new ArrayValue([new StringValue(key), value])));
				case "length": return new IntegerValue(operand.value.size);
				default: {
					const builtin = operand.builtins.get(filter.value);
					if (builtin) {
						if (builtin instanceof FunctionValue) return builtin.value([], environment);
						return builtin;
					}
					throw new Error(`Unknown ObjectValue filter: ${filter.value}`);
				}
			}
			else if (operand instanceof BooleanValue) switch (filter.value) {
				case "bool": return new BooleanValue(operand.value);
				case "int": return new IntegerValue(operand.value ? 1 : 0);
				case "float": return new FloatValue(operand.value ? 1 : 0);
				case "string": return new StringValue(operand.value ? "true" : "false");
				default: throw new Error(`Unknown BooleanValue filter: ${filter.value}`);
			}
			throw new Error(`Cannot apply filter "${filter.value}" to type: ${operand.type}`);
		} else if (filterNode.type === "CallExpression") {
			const filter = filterNode;
			if (filter.callee.type !== "Identifier") throw new Error(`Unknown filter: ${filter.callee.type}`);
			const filterName = filter.callee.value;
			if (filterName === "tojson") {
				const [, kwargs] = this.evaluateArguments(filter.args, environment);
				const indent = kwargs.get("indent") ?? new NullValue();
				if (!(indent instanceof IntegerValue || indent instanceof NullValue)) throw new Error("If set, indent must be a number");
				const ensureAscii = kwargs.get("ensure_ascii") ?? new BooleanValue(false);
				if (!(ensureAscii instanceof BooleanValue)) throw new Error("If set, ensure_ascii must be a boolean");
				const sortKeys = kwargs.get("sort_keys") ?? new BooleanValue(false);
				if (!(sortKeys instanceof BooleanValue)) throw new Error("If set, sort_keys must be a boolean");
				const separatorsArg = kwargs.get("separators") ?? new NullValue();
				let separators = null;
				if (separatorsArg instanceof ArrayValue || separatorsArg instanceof TupleValue) {
					if (separatorsArg.value.length !== 2) throw new Error("separators must be a tuple of two strings");
					const [itemSep, keySep] = separatorsArg.value;
					if (!(itemSep instanceof StringValue) || !(keySep instanceof StringValue)) throw new Error("separators must be a tuple of two strings");
					separators = [itemSep.value, keySep.value];
				} else if (!(separatorsArg instanceof NullValue)) throw new Error("If set, separators must be a tuple of two strings");
				return new StringValue(toJSON(operand, {
					indent: indent.value,
					ensureAscii: ensureAscii.value,
					sortKeys: sortKeys.value,
					separators
				}));
			} else if (filterName === "join") {
				let value;
				if (operand instanceof StringValue) value = Array.from(operand.value);
				else if (operand instanceof ArrayValue) value = operand.value.map((x) => x.value);
				else throw new Error(`Cannot apply filter "${filterName}" to type: ${operand.type}`);
				const [args, kwargs] = this.evaluateArguments(filter.args, environment);
				const separator = args.at(0) ?? kwargs.get("separator") ?? new StringValue("");
				if (!(separator instanceof StringValue)) throw new Error("separator must be a string");
				return new StringValue(value.join(separator.value));
			} else if (filterName === "int" || filterName === "float") {
				const [args, kwargs] = this.evaluateArguments(filter.args, environment);
				const defaultValue = args.at(0) ?? kwargs.get("default") ?? (filterName === "int" ? new IntegerValue(0) : new FloatValue(0));
				if (operand instanceof StringValue) {
					const val = filterName === "int" ? parseInt(operand.value, 10) : parseFloat(operand.value);
					return isNaN(val) ? defaultValue : filterName === "int" ? new IntegerValue(val) : new FloatValue(val);
				} else if (operand instanceof IntegerValue || operand instanceof FloatValue) return operand;
				else if (operand instanceof BooleanValue) return filterName === "int" ? new IntegerValue(operand.value ? 1 : 0) : new FloatValue(operand.value ? 1 : 0);
				else throw new Error(`Cannot apply filter "${filterName}" to type: ${operand.type}`);
			} else if (filterName === "default") {
				const [args, kwargs] = this.evaluateArguments(filter.args, environment);
				const defaultValue = args[0] ?? new StringValue("");
				const booleanValue = args[1] ?? kwargs.get("boolean") ?? new BooleanValue(false);
				if (!(booleanValue instanceof BooleanValue)) throw new Error("`default` filter flag must be a boolean");
				if (operand instanceof UndefinedValue || booleanValue.value && !operand.__bool__().value) return defaultValue;
				return operand;
			}
			if (operand instanceof ArrayValue) {
				switch (filterName) {
					case "sort": {
						const [args, kwargs] = this.evaluateArguments(filter.args, environment);
						const reverse = args.at(0) ?? kwargs.get("reverse") ?? new BooleanValue(false);
						if (!(reverse instanceof BooleanValue)) throw new Error("reverse must be a boolean");
						const caseSensitive = args.at(1) ?? kwargs.get("case_sensitive") ?? new BooleanValue(false);
						if (!(caseSensitive instanceof BooleanValue)) throw new Error("case_sensitive must be a boolean");
						const attribute = args.at(2) ?? kwargs.get("attribute") ?? new NullValue();
						if (!(attribute instanceof StringValue || attribute instanceof IntegerValue || attribute instanceof NullValue)) throw new Error("attribute must be a string, integer, or null");
						const getSortValue = (item) => {
							if (attribute instanceof NullValue) return item;
							return getAttributeValue(item, attribute instanceof IntegerValue ? String(attribute.value) : attribute.value);
						};
						return new ArrayValue(operand.value.slice().sort((a, b) => {
							const result = compareRuntimeValues(getSortValue(a), getSortValue(b), caseSensitive.value);
							return reverse.value ? -result : result;
						}));
					}
					case "selectattr":
					case "rejectattr": {
						const select = filterName === "selectattr";
						if (operand.value.some((x) => !(x instanceof ObjectValue))) throw new Error(`\`${filterName}\` can only be applied to array of objects`);
						if (filter.args.some((x) => x.type !== "StringLiteral")) throw new Error(`arguments of \`${filterName}\` must be strings`);
						const [attr, testName, value] = filter.args.map((x) => this.evaluate(x, environment));
						let testFunction;
						if (testName) {
							const test = environment.tests.get(testName.value);
							if (!test) throw new Error(`Unknown test: ${testName.value}`);
							testFunction = test;
						} else testFunction = (...x) => x[0].__bool__().value;
						return new ArrayValue(operand.value.filter((item) => {
							const a = item.value.get(attr.value);
							const result = a ? testFunction(a, value) : false;
							return select ? result : !result;
						}));
					}
					case "map": {
						const [, kwargs] = this.evaluateArguments(filter.args, environment);
						if (kwargs.has("attribute")) {
							const attr = kwargs.get("attribute");
							if (!(attr instanceof StringValue)) throw new Error("attribute must be a string");
							const defaultValue = kwargs.get("default");
							return new ArrayValue(operand.value.map((item) => {
								if (!(item instanceof ObjectValue)) throw new Error("items in map must be an object");
								const value = getAttributeValue(item, attr.value);
								return value instanceof UndefinedValue ? defaultValue ?? new UndefinedValue() : value;
							}));
						} else throw new Error("`map` expressions without `attribute` set are not currently supported.");
					}
				}
				throw new Error(`Unknown ArrayValue filter: ${filterName}`);
			} else if (operand instanceof StringValue) {
				switch (filterName) {
					case "indent": {
						const [args, kwargs] = this.evaluateArguments(filter.args, environment);
						const width = args.at(0) ?? kwargs.get("width") ?? new IntegerValue(4);
						if (!(width instanceof IntegerValue)) throw new Error("width must be a number");
						const first = args.at(1) ?? kwargs.get("first") ?? new BooleanValue(false);
						const blank = args.at(2) ?? kwargs.get("blank") ?? new BooleanValue(false);
						const lines = operand.value.split("\n");
						const indent = " ".repeat(width.value);
						return new StringValue(lines.map((x, i) => !first.value && i === 0 || !blank.value && x.length === 0 ? x : indent + x).join("\n"));
					}
					case "replace": {
						const replaceFn = operand.builtins.get("replace");
						if (!(replaceFn instanceof FunctionValue)) throw new Error("replace filter not available");
						const [args, kwargs] = this.evaluateArguments(filter.args, environment);
						return replaceFn.value([...args, new KeywordArgumentsValue(kwargs)], environment);
					}
				}
				throw new Error(`Unknown StringValue filter: ${filterName}`);
			} else if (operand instanceof ObjectValue) {
				const builtin = operand.builtins.get(filterName);
				if (builtin && builtin instanceof FunctionValue) {
					const [args, kwargs] = this.evaluateArguments(filter.args, environment);
					if (kwargs.size > 0) args.push(new KeywordArgumentsValue(kwargs));
					return builtin.value(args, environment);
				}
				throw new Error(`Unknown ObjectValue filter: ${filterName}`);
			} else throw new Error(`Cannot apply filter "${filterName}" to type: ${operand.type}`);
		}
		throw new Error(`Unknown filter: ${filterNode.type}`);
	}
	/**
	* Evaluates expressions following the filter operation type.
	*/
	evaluateFilterExpression(node, environment) {
		const operand = this.evaluate(node.operand, environment);
		return this.applyFilter(operand, node.filter, environment);
	}
	/**
	* Evaluates expressions following the test operation type.
	*/
	evaluateTestExpression(node, environment) {
		const operand = this.evaluate(node.operand, environment);
		const test = environment.tests.get(node.test.value);
		if (!test) throw new Error(`Unknown test: ${node.test.value}`);
		const result = test(operand);
		return new BooleanValue(node.negate ? !result : result);
	}
	/**
	* Evaluates expressions following the select operation type.
	*/
	evaluateSelectExpression(node, environment) {
		if (!this.evaluate(node.test, environment).__bool__().value) return new UndefinedValue();
		return this.evaluate(node.lhs, environment);
	}
	/**
	* Evaluates expressions following the unary operation type.
	*/
	evaluateUnaryExpression(node, environment) {
		const argument = this.evaluate(node.argument, environment);
		switch (node.operator.value) {
			case "not": return new BooleanValue(!argument.value);
			default: throw new SyntaxError(`Unknown operator: ${node.operator.value}`);
		}
	}
	evaluateTernaryExpression(node, environment) {
		return this.evaluate(node.condition, environment).__bool__().value ? this.evaluate(node.trueExpr, environment) : this.evaluate(node.falseExpr, environment);
	}
	evalProgram(program, environment) {
		return this.evaluateBlock(program.body, environment);
	}
	evaluateBlock(statements, environment) {
		let result = "";
		for (const statement of statements) {
			const lastEvaluated = this.evaluate(statement, environment);
			if (lastEvaluated.type !== "NullValue" && lastEvaluated.type !== "UndefinedValue") result += lastEvaluated.toString();
		}
		return new StringValue(result);
	}
	evaluateIdentifier(node, environment) {
		return environment.lookupVariable(node.value);
	}
	evaluateCallExpression(expr, environment) {
		const [args, kwargs] = this.evaluateArguments(expr.args, environment);
		if (kwargs.size > 0) args.push(new KeywordArgumentsValue(kwargs));
		const fn = this.evaluate(expr.callee, environment);
		if (fn.type !== "FunctionValue") throw new Error(`Cannot call something that is not a function: got ${fn.type}`);
		return fn.value(args, environment);
	}
	evaluateSliceExpression(object, expr, environment) {
		if (!(object instanceof ArrayValue || object instanceof StringValue)) throw new Error("Slice object must be an array or string");
		const start = this.evaluate(expr.start, environment);
		const stop = this.evaluate(expr.stop, environment);
		const step = this.evaluate(expr.step, environment);
		if (!(start instanceof IntegerValue || start instanceof UndefinedValue)) throw new Error("Slice start must be numeric or undefined");
		if (!(stop instanceof IntegerValue || stop instanceof UndefinedValue)) throw new Error("Slice stop must be numeric or undefined");
		if (!(step instanceof IntegerValue || step instanceof UndefinedValue)) throw new Error("Slice step must be numeric or undefined");
		if (object instanceof ArrayValue) return new ArrayValue(slice(object.value, start.value, stop.value, step.value));
		else return new StringValue(slice(Array.from(object.value), start.value, stop.value, step.value).join(""));
	}
	evaluateMemberExpression(expr, environment) {
		const object = this.evaluate(expr.object, environment);
		let property;
		if (expr.computed) if (expr.property.type === "SliceExpression") return this.evaluateSliceExpression(object, expr.property, environment);
		else property = this.evaluate(expr.property, environment);
		else if (expr.property.type === "IntegerLiteral") property = new IntegerValue(expr.property.value);
		else property = new StringValue(expr.property.value);
		let value;
		if (object instanceof ObjectValue) {
			if (!(property instanceof StringValue)) throw new Error(`Cannot access property with non-string: got ${property.type}`);
			value = object.value.get(property.value) ?? object.builtins.get(property.value);
		} else if (object instanceof ArrayValue || object instanceof StringValue) if (property instanceof IntegerValue) {
			value = object.value.at(property.value);
			if (object instanceof StringValue) value = new StringValue(object.value.at(property.value));
		} else if (property instanceof StringValue) value = object.builtins.get(property.value);
		else throw new Error(`Cannot access property with non-string/non-number: got ${property.type}`);
		else {
			if (!(property instanceof StringValue)) throw new Error(`Cannot access property with non-string: got ${property.type}`);
			value = object.builtins.get(property.value);
		}
		return value instanceof RuntimeValue ? value : new UndefinedValue();
	}
	evaluateSet(node, environment) {
		const rhs = node.value ? this.evaluate(node.value, environment) : this.evaluateBlock(node.body, environment);
		if (node.assignee.type === "Identifier") {
			const variableName = node.assignee.value;
			environment.setVariable(variableName, rhs);
		} else if (node.assignee.type === "TupleLiteral") {
			const tuple = node.assignee;
			if (!(rhs instanceof ArrayValue)) throw new Error(`Cannot unpack non-iterable type in set: ${rhs.type}`);
			const arr = rhs.value;
			if (arr.length !== tuple.value.length) throw new Error(`Too ${tuple.value.length > arr.length ? "few" : "many"} items to unpack in set`);
			for (let i = 0; i < tuple.value.length; ++i) {
				const elem = tuple.value[i];
				if (elem.type !== "Identifier") throw new Error(`Cannot unpack to non-identifier in set: ${elem.type}`);
				environment.setVariable(elem.value, arr[i]);
			}
		} else if (node.assignee.type === "MemberExpression") {
			const member = node.assignee;
			const object = this.evaluate(member.object, environment);
			if (!(object instanceof ObjectValue)) throw new Error("Cannot assign to member of non-object");
			if (member.property.type !== "Identifier") throw new Error("Cannot assign to member with non-identifier property");
			object.value.set(member.property.value, rhs);
		} else throw new Error(`Invalid LHS inside assignment expression: ${JSON.stringify(node.assignee)}`);
		return new NullValue();
	}
	evaluateIf(node, environment) {
		const test = this.evaluate(node.test, environment);
		return this.evaluateBlock(test.__bool__().value ? node.body : node.alternate, environment);
	}
	evaluateFor(node, environment) {
		const scope = new Environment(environment);
		let test, iterable;
		if (node.iterable.type === "SelectExpression") {
			const select = node.iterable;
			iterable = this.evaluate(select.lhs, scope);
			test = select.test;
		} else iterable = this.evaluate(node.iterable, scope);
		if (!(iterable instanceof ArrayValue || iterable instanceof ObjectValue)) throw new Error(`Expected iterable or object type in for loop: got ${iterable.type}`);
		if (iterable instanceof ObjectValue) iterable = iterable.keys();
		const items = [];
		const scopeUpdateFunctions = [];
		for (let i = 0; i < iterable.value.length; ++i) {
			const loopScope = new Environment(scope);
			const current = iterable.value[i];
			let scopeUpdateFunction;
			if (node.loopvar.type === "Identifier") scopeUpdateFunction = (scope2) => scope2.setVariable(node.loopvar.value, current);
			else if (node.loopvar.type === "TupleLiteral") {
				const loopvar = node.loopvar;
				if (current.type !== "ArrayValue") throw new Error(`Cannot unpack non-iterable type: ${current.type}`);
				const c = current;
				if (loopvar.value.length !== c.value.length) throw new Error(`Too ${loopvar.value.length > c.value.length ? "few" : "many"} items to unpack`);
				scopeUpdateFunction = (scope2) => {
					for (let j = 0; j < loopvar.value.length; ++j) {
						if (loopvar.value[j].type !== "Identifier") throw new Error(`Cannot unpack non-identifier type: ${loopvar.value[j].type}`);
						scope2.setVariable(loopvar.value[j].value, c.value[j]);
					}
				};
			} else throw new Error(`Invalid loop variable(s): ${node.loopvar.type}`);
			if (test) {
				scopeUpdateFunction(loopScope);
				if (!this.evaluate(test, loopScope).__bool__().value) continue;
			}
			items.push(current);
			scopeUpdateFunctions.push(scopeUpdateFunction);
		}
		let result = "";
		let noIteration = true;
		for (let i = 0; i < items.length; ++i) {
			const loop = /* @__PURE__ */ new Map([
				["index", new IntegerValue(i + 1)],
				["index0", new IntegerValue(i)],
				["revindex", new IntegerValue(items.length - i)],
				["revindex0", new IntegerValue(items.length - i - 1)],
				["first", new BooleanValue(i === 0)],
				["last", new BooleanValue(i === items.length - 1)],
				["length", new IntegerValue(items.length)],
				["previtem", i > 0 ? items[i - 1] : new UndefinedValue()],
				["nextitem", i < items.length - 1 ? items[i + 1] : new UndefinedValue()]
			]);
			scope.setVariable("loop", new ObjectValue(loop));
			scopeUpdateFunctions[i](scope);
			try {
				const evaluated = this.evaluateBlock(node.body, scope);
				result += evaluated.value;
			} catch (err) {
				if (err instanceof ContinueControl) continue;
				if (err instanceof BreakControl) break;
				throw err;
			}
			noIteration = false;
		}
		if (noIteration) {
			const defaultEvaluated = this.evaluateBlock(node.defaultBlock, scope);
			result += defaultEvaluated.value;
		}
		return new StringValue(result);
	}
	/**
	* See https://jinja.palletsprojects.com/en/3.1.x/templates/#macros for more information.
	*/
	evaluateMacro(node, environment) {
		environment.setVariable(node.name.value, new FunctionValue((args, scope) => {
			const macroScope = new Environment(scope);
			args = args.slice();
			let kwargs;
			if (args.at(-1)?.type === "KeywordArgumentsValue") kwargs = args.pop();
			for (let i = 0; i < node.args.length; ++i) {
				const nodeArg = node.args[i];
				const passedArg = args[i];
				if (nodeArg.type === "Identifier") {
					const identifier = nodeArg;
					if (!passedArg) throw new Error(`Missing positional argument: ${identifier.value}`);
					macroScope.setVariable(identifier.value, passedArg);
				} else if (nodeArg.type === "KeywordArgumentExpression") {
					const kwarg = nodeArg;
					const value = passedArg ?? kwargs?.value.get(kwarg.key.value) ?? this.evaluate(kwarg.value, macroScope);
					macroScope.setVariable(kwarg.key.value, value);
				} else throw new Error(`Unknown argument type: ${nodeArg.type}`);
			}
			return this.evaluateBlock(node.body, macroScope);
		}));
		return new NullValue();
	}
	evaluateCallStatement(node, environment) {
		const callerFn = new FunctionValue((callerArgs, callerEnv) => {
			const callBlockEnv = new Environment(callerEnv);
			if (node.callerArgs) for (let i = 0; i < node.callerArgs.length; ++i) {
				const param = node.callerArgs[i];
				if (param.type !== "Identifier") throw new Error(`Caller parameter must be an identifier, got ${param.type}`);
				callBlockEnv.setVariable(param.value, callerArgs[i] ?? new UndefinedValue());
			}
			return this.evaluateBlock(node.body, callBlockEnv);
		});
		const [macroArgs, macroKwargs] = this.evaluateArguments(node.call.args, environment);
		macroArgs.push(new KeywordArgumentsValue(macroKwargs));
		const fn = this.evaluate(node.call.callee, environment);
		if (fn.type !== "FunctionValue") throw new Error(`Cannot call something that is not a function: got ${fn.type}`);
		const newEnv = new Environment(environment);
		newEnv.setVariable("caller", callerFn);
		return fn.value(macroArgs, newEnv);
	}
	evaluateFilterStatement(node, environment) {
		const rendered = this.evaluateBlock(node.body, environment);
		return this.applyFilter(rendered, node.filter, environment);
	}
	evaluate(statement, environment) {
		if (!statement) return new UndefinedValue();
		switch (statement.type) {
			case "Program": return this.evalProgram(statement, environment);
			case "Set": return this.evaluateSet(statement, environment);
			case "If": return this.evaluateIf(statement, environment);
			case "For": return this.evaluateFor(statement, environment);
			case "Macro": return this.evaluateMacro(statement, environment);
			case "CallStatement": return this.evaluateCallStatement(statement, environment);
			case "Break": throw new BreakControl();
			case "Continue": throw new ContinueControl();
			case "IntegerLiteral": return new IntegerValue(statement.value);
			case "FloatLiteral": return new FloatValue(statement.value);
			case "StringLiteral": return new StringValue(statement.value);
			case "ArrayLiteral": return new ArrayValue(statement.value.map((x) => this.evaluate(x, environment)));
			case "TupleLiteral": return new TupleValue(statement.value.map((x) => this.evaluate(x, environment)));
			case "ObjectLiteral": {
				const mapping = /* @__PURE__ */ new Map();
				for (const [key, value] of statement.value) {
					const evaluatedKey = this.evaluate(key, environment);
					if (!(evaluatedKey instanceof StringValue)) throw new Error(`Object keys must be strings: got ${evaluatedKey.type}`);
					mapping.set(evaluatedKey.value, this.evaluate(value, environment));
				}
				return new ObjectValue(mapping);
			}
			case "Identifier": return this.evaluateIdentifier(statement, environment);
			case "CallExpression": return this.evaluateCallExpression(statement, environment);
			case "MemberExpression": return this.evaluateMemberExpression(statement, environment);
			case "UnaryExpression": return this.evaluateUnaryExpression(statement, environment);
			case "BinaryExpression": return this.evaluateBinaryExpression(statement, environment);
			case "FilterExpression": return this.evaluateFilterExpression(statement, environment);
			case "FilterStatement": return this.evaluateFilterStatement(statement, environment);
			case "TestExpression": return this.evaluateTestExpression(statement, environment);
			case "SelectExpression": return this.evaluateSelectExpression(statement, environment);
			case "Ternary": return this.evaluateTernaryExpression(statement, environment);
			case "Comment": return new NullValue();
			default: throw new SyntaxError(`Unknown node type: ${statement.type}`);
		}
	}
};
function convertToRuntimeValues(input) {
	switch (typeof input) {
		case "number": return Number.isInteger(input) ? new IntegerValue(input) : new FloatValue(input);
		case "string": return new StringValue(input);
		case "boolean": return new BooleanValue(input);
		case "undefined": return new UndefinedValue();
		case "object": if (input === null) return new NullValue();
		else if (Array.isArray(input)) return new ArrayValue(input.map(convertToRuntimeValues));
		else return new ObjectValue(new Map(Object.entries(input).map(([key, value]) => [key, convertToRuntimeValues(value)])));
		case "function": return new FunctionValue((args, _scope) => {
			return convertToRuntimeValues(input(...args.map((x) => x.value)) ?? null);
		});
		default: throw new Error(`Cannot convert to runtime value: ${input}`);
	}
}
var NEWLINE = "\n";
var OPEN_STATEMENT = "{%- ";
var CLOSE_STATEMENT = " -%}";
function getBinaryOperatorPrecedence(expr) {
	switch (expr.operator.type) {
		case "MultiplicativeBinaryOperator": return 4;
		case "AdditiveBinaryOperator": return 3;
		case "ComparisonBinaryOperator": return 2;
		case "Identifier":
			if (expr.operator.value === "and") return 1;
			if (expr.operator.value === "in" || expr.operator.value === "not in") return 2;
			return 0;
	}
	return 0;
}
function format(program, indent = "	") {
	const indentStr = typeof indent === "number" ? " ".repeat(indent) : indent;
	return formatStatements(program.body, 0, indentStr).replace(/\n$/, "");
}
function createStatement(...text) {
	return OPEN_STATEMENT + text.join(" ") + CLOSE_STATEMENT;
}
function formatStatements(stmts, depth, indentStr) {
	return stmts.map((stmt) => formatStatement(stmt, depth, indentStr)).join(NEWLINE);
}
function formatStatement(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	switch (node.type) {
		case "Program": return formatStatements(node.body, depth, indentStr);
		case "If": return formatIf(node, depth, indentStr);
		case "For": return formatFor(node, depth, indentStr);
		case "Set": return formatSet(node, depth, indentStr);
		case "Macro": return formatMacro(node, depth, indentStr);
		case "Break": return pad + createStatement("break");
		case "Continue": return pad + createStatement("continue");
		case "CallStatement": return formatCallStatement(node, depth, indentStr);
		case "FilterStatement": return formatFilterStatement(node, depth, indentStr);
		case "Comment": return pad + "{# " + node.value + " #}";
		default: return pad + "{{- " + formatExpression(node) + " -}}";
	}
}
function formatIf(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	const clauses = [];
	let current = node;
	while (current) {
		clauses.push({
			test: current.test,
			body: current.body
		});
		if (current.alternate.length === 1 && current.alternate[0].type === "If") current = current.alternate[0];
		else break;
	}
	let out = pad + createStatement("if", formatExpression(clauses[0].test)) + NEWLINE + formatStatements(clauses[0].body, depth + 1, indentStr);
	for (let i = 1; i < clauses.length; ++i) out += NEWLINE + pad + createStatement("elif", formatExpression(clauses[i].test)) + NEWLINE + formatStatements(clauses[i].body, depth + 1, indentStr);
	if (current && current.alternate.length > 0) out += NEWLINE + pad + createStatement("else") + NEWLINE + formatStatements(current.alternate, depth + 1, indentStr);
	out += NEWLINE + pad + createStatement("endif");
	return out;
}
function formatFor(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	let formattedIterable = "";
	if (node.iterable.type === "SelectExpression") {
		const n = node.iterable;
		formattedIterable = `${formatExpression(n.lhs)} if ${formatExpression(n.test)}`;
	} else formattedIterable = formatExpression(node.iterable);
	let out = pad + createStatement("for", formatExpression(node.loopvar), "in", formattedIterable) + NEWLINE + formatStatements(node.body, depth + 1, indentStr);
	if (node.defaultBlock.length > 0) out += NEWLINE + pad + createStatement("else") + NEWLINE + formatStatements(node.defaultBlock, depth + 1, indentStr);
	out += NEWLINE + pad + createStatement("endfor");
	return out;
}
function formatSet(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	const left = formatExpression(node.assignee);
	const right = node.value ? formatExpression(node.value) : "";
	const value = pad + createStatement("set", `${left}${node.value ? " = " + right : ""}`);
	if (node.body.length === 0) return value;
	return value + NEWLINE + formatStatements(node.body, depth + 1, indentStr) + NEWLINE + pad + createStatement("endset");
}
function formatMacro(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	const args = node.args.map(formatExpression).join(", ");
	return pad + createStatement("macro", `${node.name.value}(${args})`) + NEWLINE + formatStatements(node.body, depth + 1, indentStr) + NEWLINE + pad + createStatement("endmacro");
}
function formatCallStatement(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	const params = node.callerArgs && node.callerArgs.length > 0 ? `(${node.callerArgs.map(formatExpression).join(", ")})` : "";
	const callExpr = formatExpression(node.call);
	let out = pad + createStatement(`call${params}`, callExpr) + NEWLINE;
	out += formatStatements(node.body, depth + 1, indentStr) + NEWLINE;
	out += pad + createStatement("endcall");
	return out;
}
function formatFilterStatement(node, depth, indentStr) {
	const pad = indentStr.repeat(depth);
	let out = pad + createStatement("filter", node.filter.type === "Identifier" ? node.filter.value : formatExpression(node.filter)) + NEWLINE;
	out += formatStatements(node.body, depth + 1, indentStr) + NEWLINE;
	out += pad + createStatement("endfilter");
	return out;
}
function formatExpression(node, parentPrec = -1) {
	switch (node.type) {
		case "SpreadExpression": return `*${formatExpression(node.argument)}`;
		case "Identifier": return node.value;
		case "IntegerLiteral": return `${node.value}`;
		case "FloatLiteral": return `${node.value}`;
		case "StringLiteral": return JSON.stringify(node.value);
		case "BinaryExpression": {
			const n = node;
			const thisPrecedence = getBinaryOperatorPrecedence(n);
			const left = formatExpression(n.left, thisPrecedence);
			const right = formatExpression(n.right, thisPrecedence + 1);
			const expr = `${left} ${n.operator.value} ${right}`;
			return thisPrecedence < parentPrec ? `(${expr})` : expr;
		}
		case "UnaryExpression": {
			const n = node;
			return n.operator.value + (n.operator.value === "not" ? " " : "") + formatExpression(n.argument, Infinity);
		}
		case "CallExpression": {
			const n = node;
			const args = n.args.map(formatExpression).join(", ");
			return `${formatExpression(n.callee)}(${args})`;
		}
		case "MemberExpression": {
			const n = node;
			let obj = formatExpression(n.object);
			if (![
				"Identifier",
				"MemberExpression",
				"CallExpression",
				"StringLiteral",
				"IntegerLiteral",
				"FloatLiteral",
				"ArrayLiteral",
				"TupleLiteral",
				"ObjectLiteral"
			].includes(n.object.type)) obj = `(${obj})`;
			let prop = formatExpression(n.property);
			if (!n.computed && n.property.type !== "Identifier" && n.property.type !== "IntegerLiteral") prop = `(${prop})`;
			return n.computed ? `${obj}[${prop}]` : `${obj}.${prop}`;
		}
		case "FilterExpression": {
			const n = node;
			const operand = formatExpression(n.operand, Infinity);
			if (n.filter.type === "CallExpression") return `${operand} | ${formatExpression(n.filter)}`;
			return `${operand} | ${n.filter.value}`;
		}
		case "SelectExpression": {
			const n = node;
			return `${formatExpression(n.lhs)} if ${formatExpression(n.test)}`;
		}
		case "TestExpression": {
			const n = node;
			return `${formatExpression(n.operand)} is${n.negate ? " not" : ""} ${n.test.value}`;
		}
		case "ArrayLiteral":
		case "TupleLiteral": {
			const elems = node.value.map(formatExpression);
			const brackets = node.type === "ArrayLiteral" ? "[]" : "()";
			return `${brackets[0]}${elems.join(", ")}${brackets[1]}`;
		}
		case "ObjectLiteral": return `{${Array.from(node.value.entries()).map(([k, v]) => `${formatExpression(k)}: ${formatExpression(v)}`).join(", ")}}`;
		case "SliceExpression": {
			const n = node;
			return `${n.start ? formatExpression(n.start) : ""}:${n.stop ? formatExpression(n.stop) : ""}${n.step ? `:${formatExpression(n.step)}` : ""}`;
		}
		case "KeywordArgumentExpression": {
			const n = node;
			return `${n.key.value}=${formatExpression(n.value)}`;
		}
		case "Ternary": {
			const n = node;
			const expr = `${formatExpression(n.trueExpr)} if ${formatExpression(n.condition, 0)} else ${formatExpression(n.falseExpr)}`;
			return parentPrec > -1 ? `(${expr})` : expr;
		}
		default: throw new Error(`Unknown expression type: ${node.type}`);
	}
}
var Template = class {
	parsed;
	/**
	* @param {string} template The template string
	*/
	constructor(template) {
		const tokens = tokenize(template, {
			lstrip_blocks: true,
			trim_blocks: true
		});
		this.parsed = parse(tokens);
	}
	render(items) {
		const env = new Environment();
		setupGlobals(env);
		if (items) for (const [key, value] of Object.entries(items)) env.set(key, value);
		return new Interpreter(env).run(this.parsed).value;
	}
	format(options) {
		return format(this.parsed, options?.indent || "	");
	}
};
//#endregion
//#region src/chat/tokenizer.ts
/*!
* bitgpu/chat bundles @huggingface/tokenizers and @huggingface/jinja (Apache-2.0,
* (c) Hugging Face) at build time so the published package stays dependency-free.
* See THIRD_PARTY_LICENSES.md in the package root.
*/
const tokenString = (v) => typeof v === "string" ? v : v?.content ?? null;
var ChatTokenizer = class {
	tok;
	template;
	templateContext;
	/** End-of-sequence token id (e.g. <|im_end|> for Qwen3-family models). */
	eosTokenId;
	/** The eos token's string form (used to reconstruct the template's turn terminator). */
	eosToken;
	constructor(tokenizerJson, tokenizerConfig) {
		this.tok = new Tokenizer_default(tokenizerJson, tokenizerConfig);
		const tmpl = tokenizerConfig["chat_template"];
		this.template = typeof tmpl === "string" ? new Template(tmpl) : null;
		this.templateContext = {};
		for (const k of [
			"bos_token",
			"eos_token",
			"pad_token",
			"unk_token"
		]) {
			const s = tokenString(tokenizerConfig[k]);
			if (s !== null) this.templateContext[k] = s;
		}
		const eosStr = tokenString(tokenizerConfig["eos_token"]);
		const eosId = eosStr !== null ? this.tok.token_to_id(eosStr) : void 0;
		if (eosStr === null || eosId === void 0) throw new Error("bitgpu/chat: tokenizer_config.json has no resolvable eos_token (needed to stop generation and to reconstruct cached turns)");
		this.eosToken = eosStr;
		this.eosTokenId = eosId;
	}
	/** Encode text to token ids. `addSpecialTokens` defaults to false: the chat template already
	*  inserts the control tokens, so prompt/delta encoding must not add more. */
	encode(text, addSpecialTokens = false) {
		return Array.from(this.tok.encode(text, { add_special_tokens: addSpecialTokens }).ids, Number);
	}
	/** Decode token ids to text. `skipSpecialTokens` defaults to true (never surface control tokens). */
	decode(ids, skipSpecialTokens = true) {
		if (ids.length === 0) return "";
		return this.tok.decode(ids, { skip_special_tokens: skipSpecialTokens });
	}
	/** The raw vocab string for a token id (byte-alias space for byte-level BPE). */
	idToToken(id) {
		return this.tok.id_to_token(id);
	}
	/** The id of an exact vocab token (e.g. the <tool_call> marker); undefined when absent. */
	tokenToId(token) {
		return this.tok.token_to_id(token);
	}
	/** Ids of all added tokens (ChatML markers, <think>, etc.) - never plain content. */
	addedTokenIds() {
		return new Set(this.tok.get_added_tokens_decoder().keys());
	}
	get hasChatTemplate() {
		return this.template !== null;
	}
	/** Render a message list to a prompt string via the model's own Jinja chat template
	*  (matches transformers.js apply_chat_template byte-exactly). `tools` is passed to the
	*  template verbatim (Qwen-family templates serialize each entry into the system block). */
	applyChatTemplate(messages, opts = {}) {
		if (!this.template) throw new Error("bitgpu/chat: the model has no chat_template in tokenizer_config.json");
		return this.template.render({
			...this.templateContext,
			messages,
			tools: opts.tools ?? null,
			add_generation_prompt: opts.addGenerationPrompt ?? true,
			enable_thinking: opts.enableThinking ?? false
		});
	}
	createDecoderStream(skipSpecialTokens = true) {
		const ids = [];
		let emitted = 0;
		const decodeAll = () => this.tok.decode(ids, { skip_special_tokens: skipSpecialTokens });
		return {
			push: (tokenId) => {
				ids.push(tokenId);
				const text = decodeAll();
				let safe = text.length;
				while (safe > emitted && text.charCodeAt(safe - 1) === 65533) safe--;
				const out = text.slice(emitted, safe);
				emitted = safe;
				return out;
			},
			flush: () => {
				if (ids.length === 0) return "";
				const text = decodeAll();
				const out = text.slice(emitted);
				emitted = text.length;
				return out;
			}
		};
	}
};
//#endregion
//#region src/chat/think.ts
/** Longest suffix of `s` that is a proper prefix of `tag` (what must be held back). */
function holdback$1(s, tag) {
	const max = Math.min(s.length, tag.length - 1);
	for (let k = max; k > 0; k--) if (tag.startsWith(s.slice(s.length - k))) return s.length - k;
	return s.length;
}
var ThinkSplitter = class {
	open;
	close;
	inside;
	hold = "";
	constructor(open = "<think>", close = "</think>", startInside = false) {
		this.open = open;
		this.close = close;
		this.inside = startInside;
	}
	push(chunk) {
		let s = this.hold + chunk;
		this.hold = "";
		let text = "";
		let think = "";
		for (;;) if (!this.inside) {
			const i = s.indexOf(this.open);
			if (i === -1) {
				const safe = holdback$1(s, this.open);
				text += s.slice(0, safe);
				this.hold = s.slice(safe);
				return {
					text,
					think
				};
			}
			text += s.slice(0, i);
			s = s.slice(i + this.open.length);
			this.inside = true;
		} else {
			const i = s.indexOf(this.close);
			if (i === -1) {
				const safe = holdback$1(s, this.close);
				think += s.slice(0, safe);
				this.hold = s.slice(safe);
				return {
					text,
					think
				};
			}
			think += s.slice(0, i);
			s = s.slice(i + this.close.length);
			this.inside = false;
		}
	}
	/** Emit whatever is held back. An unterminated think block (generation hit maxTokens inside it)
	*  flushes to the think channel, never to the visible reply. */
	flush() {
		const r = this.inside ? {
			text: "",
			think: this.hold
		} : {
			text: this.hold,
			think: ""
		};
		this.hold = "";
		this.inside = false;
		return r;
	}
};
/** Stream-safe stop-sequence scanner: emits visible text up to (excluding) the earliest match of
*  any stop string, holding back chunk-edge suffixes that could begin one (stops can straddle
*  token boundaries). Once matched, everything further is swallowed. */
var StopScanner = class {
	stops;
	matched = false;
	hold = "";
	constructor(stops) {
		this.stops = stops;
	}
	push(text) {
		if (this.matched) return "";
		const s = this.hold + text;
		let mi = -1;
		for (const st of this.stops) {
			const i = s.indexOf(st);
			if (i !== -1 && (mi === -1 || i < mi)) mi = i;
		}
		if (mi !== -1) {
			this.matched = true;
			this.hold = "";
			return s.slice(0, mi);
		}
		let safe = s.length;
		for (const st of this.stops) safe = Math.min(safe, holdback$1(s, st));
		this.hold = s.slice(safe);
		return s.slice(0, safe);
	}
	flush() {
		const r = this.matched ? "" : this.hold;
		this.hold = "";
		return r;
	}
};
/** Budget-forcing for the think channel (s1-style "budget forcing", training-free): counts the
*  tokens generated inside a <think> block; once `budget` is spent - or the EARLY-STOP heuristic
*  fires (the model has been decisively confident for `window` consecutive steps after
*  `minTokens`, a signature of rote continuation rather than active reasoning) - `force()` names
*  `</think>` as the only permitted candidate (the engine's constrained pick guarantees it is
*  reachable even when outside the top-K), so the model closes its reasoning and continues
*  straight into the visible answer. `budget: 0` suppresses reasoning entirely while keeping the
*  thinking-mode template. advance() must see every emitted token; observe() should see each
*  step's candidate logits (descending) BEFORE the pick - the filter callback receives exactly
*  that. */
var ThinkBudget = class {
	openId;
	closeId;
	budget;
	early;
	inThink;
	spent = 0;
	closed = false;
	run = 0;
	earlyFired = false;
	seen = false;
	constructor(openId, closeId, budget, startInside, early = null) {
		this.openId = openId;
		this.closeId = closeId;
		this.budget = budget;
		this.early = early;
		this.inThink = startInside;
	}
	advance(id) {
		if (this.closed) return;
		if (!this.inThink) {
			if (this.openId != null && id === this.openId) this.inThink = true;
			return;
		}
		if (this.closeId != null && id === this.closeId) {
			this.inThink = false;
			this.closed = true;
			return;
		}
		this.spent++;
		this.seen = false;
	}
	/** Feed one step's candidate logits (descending). Only meaningful inside think. Counted at most
	*  once per emitted step: the engine re-invokes the candidate filter (and thus observe) once per
	*  512-token batch when it has to walk the full vocabulary for a forced token, and those
	*  batch-local gaps must not eat the early-stop window. */
	observe(vals) {
		if (!this.early || !this.inThink || this.closed || this.earlyFired || this.seen || vals.length < 2) return;
		this.seen = true;
		const confident = vals[0] - vals[1] >= this.early.gap;
		this.run = confident ? this.run + 1 : 0;
		if (this.spent >= this.early.minTokens && this.run >= this.early.window) this.earlyFired = true;
	}
	/** The forced token id once the budget is exhausted or early stop fired, else null. */
	force() {
		if (!this.inThink || this.closed || this.closeId == null) return null;
		return this.spent >= this.budget || this.earlyFired ? this.closeId : null;
	}
};
//#endregion
//#region src/chat/json.ts
const SUPPORTED = /* @__PURE__ */ new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"minItems",
	"maxItems",
	"enum",
	"oneOf",
	"minimum",
	"maximum",
	"minLength",
	"maxLength"
]);
const ANNOTATIONS = /* @__PURE__ */ new Set([
	"description",
	"title",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
	"$schema",
	"$id"
]);
const TYPES = /* @__PURE__ */ new Set([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
]);
/** The discriminator of a branch list: a property required by every branch, with a single-value
*  string enum in every branch, all values distinct. null when the union is not discriminated. */
function findDiscriminator(branches) {
	for (const k of Object.keys(branches[0]?.properties ?? {})) if (branches.every((b) => b.required?.includes(k) && b.properties?.[k]?.enum?.length === 1)) {
		const vals = branches.map((b) => b.properties[k].enum?.[0]);
		if (new Set(vals).size === branches.length) return k;
	}
	return null;
}
/** Validate a schema against the enforceable subset; throws listing anything unsupported. */
function validateJsonSchema(schema, path = "schema", isRoot = true) {
	const unknown = Object.keys(schema).filter((k) => !SUPPORTED.has(k) && !ANNOTATIONS.has(k));
	if (unknown.length) throw new Error(`bitgpu/chat: unsupported JSON Schema keyword(s) at ${path}: ${unknown.join(", ")} (enforceable subset: ${[...SUPPORTED].join(", ")}; annotations accepted-and-ignored: ${[...ANNOTATIONS].join(", ")})`);
	if (schema.oneOf !== void 0) {
		const extra = Object.keys(schema).filter((k) => k !== "oneOf" && !ANNOTATIONS.has(k));
		if (extra.length) throw new Error(`bitgpu/chat: oneOf at ${path} cannot combine with other keywords (got ${extra.join(", ")})`);
		if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) throw new Error(`bitgpu/chat: oneOf at ${path} needs at least 2 branches`);
		schema.oneOf.forEach((b, i) => {
			validateJsonSchema(b, `${path}.oneOf[${i}]`, false);
			if (b.type !== "object" || b.additionalProperties !== false || b.properties === void 0) throw new Error(`bitgpu/chat: every oneOf branch must be { type: 'object', additionalProperties: false, properties: ... } (${path}.oneOf[${i}])`);
		});
		const disc = findDiscriminator(schema.oneOf);
		if (disc === null) throw new Error(`bitgpu/chat: oneOf at ${path} must be a DISCRIMINATED union - a property required by every branch whose single-value enum differs per branch`);
		const shared = /* @__PURE__ */ new Map();
		for (const b of schema.oneOf) for (const [k, v] of Object.entries(b.properties ?? {})) {
			if (k === disc) continue;
			const s = JSON.stringify(v);
			const prev = shared.get(k);
			if (prev !== void 0 && prev !== s) throw new Error(`bitgpu/chat: property '${k}' differs between oneOf branches at ${path} (non-discriminator properties shared by branches must be identical)`);
			shared.set(k, s);
		}
		return;
	}
	if (schema.type !== void 0 && !TYPES.has(schema.type)) throw new Error(`bitgpu/chat: unsupported type '${schema.type}' at ${path}`);
	if (schema.minimum !== void 0 || schema.maximum !== void 0) {
		if (schema.type !== "integer") throw new Error(`bitgpu/chat: minimum/maximum at ${path} require type 'integer' (float ranges are not incrementally enforceable)`);
		if (schema.minimum !== void 0 && !Number.isSafeInteger(schema.minimum)) throw new Error(`bitgpu/chat: minimum at ${path} must be a safe integer`);
		if (schema.maximum !== void 0 && !Number.isSafeInteger(schema.maximum)) throw new Error(`bitgpu/chat: maximum at ${path} must be a safe integer`);
		if (schema.minimum !== void 0 && schema.maximum !== void 0 && schema.minimum > schema.maximum) throw new Error(`bitgpu/chat: minimum > maximum at ${path}`);
	}
	if (schema.minLength !== void 0 || schema.maxLength !== void 0) {
		if (schema.type !== "string") throw new Error(`bitgpu/chat: minLength/maxLength at ${path} require type 'string'`);
		if (schema.enum !== void 0) throw new Error(`bitgpu/chat: minLength/maxLength at ${path} cannot combine with enum`);
		for (const [k, v] of [["minLength", schema.minLength], ["maxLength", schema.maxLength]]) if (v !== void 0 && (!Number.isSafeInteger(v) || v < 0)) throw new Error(`bitgpu/chat: ${k} at ${path} must be a non-negative integer`);
		if (schema.minLength !== void 0 && schema.maxLength !== void 0 && schema.minLength > schema.maxLength) throw new Error(`bitgpu/chat: minLength > maxLength at ${path}`);
	}
	if (isRoot && schema.type !== void 0 && schema.type !== "object" && schema.type !== "array") throw new Error(`bitgpu/chat: the schema root must be an object or array (got '${schema.type}'); JSON mode requires a container root`);
	if (schema.enum !== void 0) {
		if (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every((v) => typeof v === "string")) throw new Error(`bitgpu/chat: enum at ${path} must be a non-empty array of strings`);
		for (const v of schema.enum) if (/["\\\u0000-\u001f]/.test(v)) throw new Error(`bitgpu/chat: enum value ${JSON.stringify(v)} at ${path} contains characters that require JSON escaping (unsupported)`);
		if (schema.type !== void 0 && schema.type !== "string") throw new Error(`bitgpu/chat: enum at ${path} requires type 'string'`);
	}
	if (schema.required !== void 0 && schema.properties !== void 0) {
		for (const k of schema.required) if (!(k in schema.properties)) throw new Error(`bitgpu/chat: required key '${k}' at ${path} is missing from properties`);
	}
	if (schema.additionalProperties === false && schema.properties === void 0) throw new Error(`bitgpu/chat: additionalProperties: false at ${path} needs a properties map`);
	if (schema.properties !== void 0) for (const [k, v] of Object.entries(schema.properties)) {
		if (/["\\\u0000-\u001f]/.test(k)) throw new Error(`bitgpu/chat: property name ${JSON.stringify(k)} at ${path} contains characters that require JSON escaping (unsupported)`);
		validateJsonSchema(v, `${path}.properties.${k}`, false);
	}
	if (schema.items !== void 0) validateJsonSchema(schema.items, `${path}.items`, false);
	if (schema.minItems !== void 0 && schema.maxItems !== void 0 && schema.minItems > schema.maxItems) throw new Error(`bitgpu/chat: minItems > maxItems at ${path}`);
}
const WS$1 = /* @__PURE__ */ new Set([
	32,
	9,
	10,
	13
]);
const isDigit = (b) => b >= 48 && b <= 57;
const isHex = (b) => isDigit(b) || b >= 65 && b <= 70 || b >= 97 && b <= 102;
const numberDone = (s) => s === 1 || s === 2 || s === 4 || s === 7;
const utf8$1 = new TextEncoder();
var JsonMachine = class JsonMachine {
	root;
	stack = [];
	phase = 0;
	uLeft = 0;
	utf8Left = 0;
	numSub = 2;
	numInt = false;
	litWord = "";
	litPos = 0;
	strKind = "value";
	strBuf = "";
	strTracking = false;
	enumCands = null;
	strLenOn = false;
	strCount = 0;
	strMin = 0;
	strMax = Infinity;
	numMin = null;
	numMax = null;
	numBuf = "";
	pending = null;
	wsRun = 0;
	constructor(root = null) {
		this.root = root;
		this.pending = root;
	}
	clone() {
		const m = new JsonMachine(this.root);
		m.stack = this.stack.map((c) => ({
			kind: c.kind,
			node: c.node,
			seen: c.seen.slice(),
			count: c.count,
			branches: c.branches ? c.branches.slice() : null,
			discRaw: c.discRaw,
			discKey: c.discKey,
			discPending: c.discPending
		}));
		m.phase = this.phase;
		m.uLeft = this.uLeft;
		m.utf8Left = this.utf8Left;
		m.numSub = this.numSub;
		m.numInt = this.numInt;
		m.litWord = this.litWord;
		m.litPos = this.litPos;
		m.strKind = this.strKind;
		m.strBuf = this.strBuf;
		m.strTracking = this.strTracking;
		m.enumCands = this.enumCands;
		m.strLenOn = this.strLenOn;
		m.strCount = this.strCount;
		m.strMin = this.strMin;
		m.strMax = this.strMax;
		m.numMin = this.numMin;
		m.numMax = this.numMax;
		m.numBuf = this.numBuf;
		m.pending = this.pending;
		m.wsRun = this.wsRun;
		return m;
	}
	get complete() {
		return this.phase === 12;
	}
	/** Feed bytes; false = the text stopped being a valid schema-conforming prefix (state is then undefined). */
	feed(bytes) {
		for (let i = 0; i < bytes.length; i++) if (!this.byte(bytes[i])) return false;
		return true;
	}
	top() {
		return this.stack[this.stack.length - 1];
	}
	/** Byte-space form of a string literal (what strBuf accumulates). */
	static bytesOf(s) {
		return String.fromCharCode(...utf8$1.encode(s));
	}
	openValue(b) {
		const sc = this.pending;
		const t = sc?.type;
		if (sc?.enum !== void 0 && b !== 34) return false;
		if (sc?.oneOf !== void 0) {
			if (b !== 123) return false;
			const discRaw = findDiscriminator(sc.oneOf);
			this.stack.push({
				kind: "{",
				node: null,
				seen: [],
				count: 0,
				branches: sc.oneOf.slice(),
				discRaw,
				discKey: JsonMachine.bytesOf(discRaw),
				discPending: false
			});
			this.phase = 3;
			this.pending = null;
			return true;
		}
		if (b === 123) {
			if (t !== void 0 && t !== "object") return false;
			this.stack.push({
				kind: "{",
				node: sc ?? null,
				seen: [],
				count: 0,
				branches: null,
				discRaw: null,
				discKey: null,
				discPending: false
			});
			this.phase = 3;
		} else if (b === 91) {
			if (t !== void 0 && t !== "array") return false;
			this.stack.push({
				kind: "[",
				node: sc ?? null,
				seen: [],
				count: 0,
				branches: null,
				discRaw: null,
				discKey: null,
				discPending: false
			});
			this.phase = 2;
		} else if (b === 34) {
			if (t !== void 0 && t !== "string") return false;
			this.strKind = sc?.enum ? "enum" : "value";
			this.enumCands = sc?.enum ? sc.enum.map(JsonMachine.bytesOf) : null;
			this.strBuf = "";
			this.strTracking = this.strKind === "enum";
			this.strLenOn = sc?.minLength !== void 0 || sc?.maxLength !== void 0;
			this.strCount = 0;
			this.strMin = sc?.minLength ?? 0;
			this.strMax = sc?.maxLength ?? Infinity;
			this.phase = 7;
		} else if (b === 45 || isDigit(b)) {
			if (t !== void 0 && t !== "number" && t !== "integer") return false;
			this.numInt = t === "integer";
			this.numMin = this.numInt ? sc?.minimum ?? null : null;
			this.numMax = this.numInt ? sc?.maximum ?? null : null;
			this.numBuf = String.fromCharCode(b);
			if (!this.intFeasible()) return false;
			this.numSub = b === 45 ? 0 : b === 48 ? 1 : 2;
			this.phase = 10;
		} else if (b === 116 || b === 102 || b === 110) {
			const word = b === 116 ? "true" : b === 102 ? "false" : "null";
			if (t !== void 0 && !(word === "null" && t === "null" || word !== "null" && t === "boolean")) return false;
			this.litWord = word;
			this.litPos = 1;
			this.phase = 11;
		} else return false;
		this.pending = null;
		return true;
	}
	/** A value just finished; land per the enclosing container and count array items. */
	closeValue() {
		const c = this.top();
		if (c === void 0) {
			this.phase = 12;
			return;
		}
		if (c.kind === "[") c.count++;
		this.phase = 6;
	}
	closeContainer(b) {
		const c = this.top();
		if (!c || c.kind !== (b === 125 ? "{" : "[")) return false;
		if (c.kind === "{") {
			if (c.branches) {
				if (!c.branches.some((br) => (br.required ?? []).every((k) => c.seen.includes(JsonMachine.bytesOf(k))))) return false;
			} else if (c.node?.required) {
				for (const k of c.node.required) if (!c.seen.includes(JsonMachine.bytesOf(k))) return false;
			}
		}
		if (c.kind === "[" && c.node?.minItems !== void 0 && c.count < c.node.minItems) return false;
		this.stack.pop();
		this.closeValue();
		return true;
	}
	/** Candidate property names for the key being typed (null = unconstrained). */
	keyCands(c) {
		if (c.branches) {
			const out = /* @__PURE__ */ new Set();
			for (const b of c.branches) for (const k of Object.keys(b.properties ?? {})) {
				const kb = JsonMachine.bytesOf(k);
				if (!c.seen.includes(kb)) out.add(kb);
			}
			return [...out];
		}
		if (!c.node || c.node.additionalProperties !== false) return null;
		return Object.keys(c.node.properties ?? {}).map(JsonMachine.bytesOf).filter((k) => !c.seen.includes(k));
	}
	startKey(c) {
		this.strKind = "key";
		this.enumCands = this.keyCands(c);
		this.strBuf = "";
		this.strTracking = true;
		this.phase = 7;
	}
	/** Structural whitespace is never REQUIRED by JSON, so capping a run cannot make the grammar
	*  unsatisfiable - but without a cap, a model denied prose can loop on whitespace forever (the
	*  grammar permits it unboundedly) and burn the whole token budget producing "[ ". 16 bytes
	*  allows generous pretty-printing indentation while forcing real progress. */
	ws() {
		return ++this.wsRun <= 16;
	}
	/** Integer bounds: can SOME digit-extension of the current number prefix (including "stop
	*  here") land inside [min, max]? The attainable values from digit string D are
	*  union over k >= 0 of sign * [D*10^k, (D+1)*10^k - 1]; leading-zero rules make 0 / -0
	*  terminal-only. Rejecting infeasible digits up front means the machine can never trap the
	*  model in an unfinishable number. */
	intFeasible() {
		if (this.numMin === null && this.numMax === null) return true;
		const lo = this.numMin ?? -Infinity;
		const hi = this.numMax ?? Infinity;
		const neg = this.numBuf[0] === "-";
		const ds = neg ? this.numBuf.slice(1) : this.numBuf;
		if (ds === "") return lo <= 0;
		if (ds === "0") return lo <= 0 && 0 <= hi;
		const D = Number(ds);
		for (let pow = 1;; pow *= 10) {
			const a = D * pow;
			const b = (D + 1) * pow - 1;
			const va = neg ? -b : a;
			const vb = neg ? -a : b;
			if (va <= hi && vb >= lo) return true;
			if (neg ? vb < lo : va > hi) return false;
			if (!Number.isSafeInteger((D + 1) * pow * 10)) return false;
		}
	}
	/** May the current number END here (bounds permitting)? */
	intInRange() {
		if (this.numMin === null && this.numMax === null) return true;
		const v = Number(this.numBuf);
		return (this.numMin === null || v >= this.numMin) && (this.numMax === null || v <= this.numMax);
	}
	/** Accept a digit into the current number, bounds permitting. */
	numAppend(b) {
		if (this.numMin === null && this.numMax === null) return true;
		this.numBuf += String.fromCharCode(b);
		return this.intFeasible();
	}
	/** Count one code point of the current string, maxLength permitting. */
	strChar() {
		return !this.strLenOn || ++this.strCount <= this.strMax;
	}
	byte(b) {
		if (!WS$1.has(b)) this.wsRun = 0;
		switch (this.phase) {
			case 0: {
				if (WS$1.has(b)) return this.ws();
				if (b === 123 || b === 91) return this.openValue(b);
				const rt = this.root?.type;
				if (rt !== void 0 && rt !== "object" && rt !== "array") return this.openValue(b);
				return false;
			}
			case 1:
				if (WS$1.has(b)) return this.ws();
				return this.openValue(b);
			case 2: {
				if (WS$1.has(b)) return this.ws();
				if (b === 93) return this.closeContainer(b);
				const c = this.top();
				if (c.node?.maxItems === 0) return false;
				this.pending = c.node?.items ?? null;
				return this.openValue(b);
			}
			case 3:
				if (WS$1.has(b)) return this.ws();
				if (b === 125) return this.closeContainer(b);
				if (b === 34) {
					const c = this.top();
					if (this.keyCands(c)?.length === 0) return false;
					this.startKey(c);
					return true;
				}
				return false;
			case 4:
				if (WS$1.has(b)) return this.ws();
				if (b === 34) {
					this.startKey(this.top());
					return true;
				}
				return false;
			case 5:
				if (WS$1.has(b)) return this.ws();
				if (b === 58) {
					const c = this.top();
					const key = c.seen[c.seen.length - 1];
					if (c.branches) if (key === c.discKey) {
						this.pending = { enum: c.branches.map((br) => br.properties[c.discRaw].enum?.[0]) };
						c.discPending = true;
					} else {
						let prop = null;
						for (const br of c.branches) {
							const hit = Object.entries(br.properties ?? {}).find(([k]) => JsonMachine.bytesOf(k) === key);
							if (hit) {
								prop = hit[1];
								break;
							}
						}
						this.pending = prop;
					}
					else {
						const prop = c.node?.properties ? Object.entries(c.node.properties).find(([k]) => JsonMachine.bytesOf(k) === key) : void 0;
						this.pending = prop ? prop[1] : null;
					}
					this.phase = 1;
					return true;
				}
				return false;
			case 6: {
				if (WS$1.has(b)) return this.ws();
				const c = this.top();
				if (b === 44 && c) {
					if (c.kind === "{") {
						if (this.keyCands(c)?.length === 0) return false;
						this.phase = 4;
					} else {
						if (c.node?.maxItems !== void 0 && c.count >= c.node.maxItems) return false;
						this.pending = c.node?.items ?? null;
						this.phase = 1;
					}
					return true;
				}
				if ((b === 125 || b === 93) && c) return this.closeContainer(b);
				return false;
			}
			case 7:
				if (this.utf8Left > 0) {
					if (b >= 128 && b <= 191) {
						this.utf8Left--;
						if (this.strTracking) this.strBuf += String.fromCharCode(b);
						return this.enumOk();
					}
					return false;
				}
				if (b === 34) {
					if (this.strKind === "key") {
						const c = this.top();
						if (this.enumCands !== null && !this.enumCands.includes(this.strBuf)) return false;
						if ((c.node?.properties || c.branches) && c.seen.includes(this.strBuf)) return false;
						c.seen.push(this.strBuf);
						if (c.branches) {
							c.branches = c.branches.filter((br) => Object.keys(br.properties ?? {}).some((k) => JsonMachine.bytesOf(k) === this.strBuf));
							if (c.branches.length === 0) return false;
						}
						this.phase = 5;
					} else {
						if (this.strKind === "enum" && !this.enumCands.includes(this.strBuf)) return false;
						if (this.strLenOn && this.strCount < this.strMin) return false;
						const c = this.top();
						if (c?.discPending) {
							c.branches = c.branches.filter((br) => JsonMachine.bytesOf(br.properties[c.discRaw].enum?.[0]) === this.strBuf);
							c.discPending = false;
							if (c.branches.length === 0) return false;
						}
						this.closeValue();
					}
					this.strTracking = false;
					this.strLenOn = false;
					return true;
				}
				if (b === 92) {
					if (this.strKind === "enum" || this.strKind === "key" && this.enumCands !== null) return false;
					if (!this.strChar()) return false;
					this.phase = 8;
					return true;
				}
				if (b < 32) return false;
				if (b < 128) {
					if (!this.strChar()) return false;
					if (this.strTracking) this.strBuf += String.fromCharCode(b);
					return this.enumOk();
				}
				if (b >= 194 && b <= 223) this.utf8Left = 1;
				else if (b >= 224 && b <= 239) this.utf8Left = 2;
				else if (b >= 240 && b <= 244) this.utf8Left = 3;
				else return false;
				if (!this.strChar()) return false;
				if (this.strTracking) this.strBuf += String.fromCharCode(b);
				return this.enumOk();
			case 8:
				if (b === 117) {
					this.uLeft = 4;
					this.phase = 9;
					return true;
				}
				if ([
					34,
					92,
					47,
					98,
					102,
					110,
					114,
					116
				].includes(b)) {
					if (this.strTracking) this.strBuf += "\\" + String.fromCharCode(b);
					this.phase = 7;
					return true;
				}
				return false;
			case 9:
				if (!isHex(b)) return false;
				if (this.strTracking) this.strBuf += String.fromCharCode(b);
				if (--this.uLeft === 0) this.phase = 7;
				return true;
			case 10:
				switch (this.numSub) {
					case 0:
						if (!isDigit(b)) return false;
						this.numSub = b === 48 ? 1 : 2;
						return this.numAppend(b);
					case 1:
					case 2:
						if (isDigit(b)) {
							if (this.numSub === 1) return false;
							return this.numAppend(b);
						}
						break;
					case 3:
						if (!isDigit(b)) return false;
						this.numSub = 4;
						return true;
					case 4:
						if (isDigit(b)) return true;
						break;
					case 5:
						if (b === 43 || b === 45) {
							this.numSub = 6;
							return true;
						}
						if (!isDigit(b)) return false;
						this.numSub = 7;
						return true;
					case 6:
						if (!isDigit(b)) return false;
						this.numSub = 7;
						return true;
					case 7:
						if (isDigit(b)) return true;
						break;
				}
				if (b === 46 && !this.numInt && (this.numSub === 1 || this.numSub === 2)) {
					this.numSub = 3;
					return true;
				}
				if ((b === 101 || b === 69) && !this.numInt && numberDone(this.numSub) && this.numSub !== 7) {
					this.numSub = 5;
					return true;
				}
				if (numberDone(this.numSub)) {
					if (!this.intInRange()) return false;
					this.closeValue();
					return this.byte(b);
				}
				return false;
			case 11:
				if (b !== this.litWord.charCodeAt(this.litPos)) return false;
				if (++this.litPos === this.litWord.length) this.closeValue();
				return true;
			case 12: return WS$1.has(b);
		}
	}
	/** In an enum/key-constrained string, the accumulated bytes must remain a prefix of some candidate. */
	enumOk() {
		if (!this.strTracking || this.enumCands === null) return true;
		const buf = this.strBuf;
		for (const c of this.enumCands) if (c.startsWith(buf)) return true;
		return false;
	}
};
function aliasToByte() {
	const bs = [];
	for (let i = 33; i <= 126; i++) bs.push(i);
	for (let i = 161; i <= 172; i++) bs.push(i);
	for (let i = 174; i <= 255; i++) bs.push(i);
	const cs = [...bs];
	let n = 0;
	for (let b = 0; b < 256; b++) if (!bs.includes(b)) {
		bs.push(b);
		cs.push(256 + n);
		n++;
	}
	return new Map(bs.map((b, i) => [cs[i], b]));
}
/** Precomputed id -> raw bytes lookup (lazy per id; added/special tokens map to null). */
var TokenByteTable = class {
	tk;
	cache = /* @__PURE__ */ new Map();
	inv = aliasToByte();
	added;
	constructor(tk) {
		this.tk = tk;
		this.added = tk.addedTokenIds();
	}
	bytes(id) {
		const hit = this.cache.get(id);
		if (hit !== void 0) return hit;
		let out = null;
		if (!this.added.has(id)) {
			const s = this.tk.idToToken(id);
			if (s !== void 0) {
				const b = new Uint8Array(s.length);
				let ok = true;
				for (let i = 0; i < s.length; i++) {
					const v = this.inv.get(s.charCodeAt(i));
					if (v === void 0) {
						ok = false;
						break;
					}
					b[i] = v;
				}
				out = ok ? b : null;
			}
		}
		this.cache.set(id, out);
		return out;
	}
};
/** The per-step candidate filter for format:'json': permit candidates whose bytes keep the text
*  a valid, schema-conforming JSON prefix; once the root value is complete, permit ONLY eos so
*  generation ends naturally. Call advance() with each chosen token to move the real machine. */
function makeJsonFilter(table, eosTokenId, schema = null) {
	const machine = new JsonMachine(schema);
	return {
		machine,
		filter: (ids) => {
			const out = [];
			for (const id of ids) {
				if (machine.complete) {
					if (id === eosTokenId) out.push(Number(id));
					continue;
				}
				const bytes = table.bytes(Number(id));
				if (!bytes || bytes.length === 0) continue;
				if (machine.clone().feed(bytes)) out.push(Number(id));
			}
			return out;
		},
		advance: (id) => {
			if (machine.complete) return;
			const bytes = table.bytes(id);
			if (bytes) machine.feed(bytes);
		}
	};
}
//#endregion
//#region src/chat/tools.ts
const BAD_NAME = /["\\\u0000-\u001f]/;
/** Validate a tools list + choice; throws on anything the enforcer cannot guarantee. */
function validateTools(tools, choice) {
	if (tools.length === 0) throw new Error("bitgpu/chat: tools is empty");
	const seen = /* @__PURE__ */ new Set();
	for (let i = 0; i < tools.length; i++) {
		const t = tools[i];
		if (t?.type !== "function" || typeof t.function?.name !== "string" || t.function.name.length === 0) throw new Error(`bitgpu/chat: tools[${i}] must be { type: 'function', function: { name, ... } }`);
		const name = t.function.name;
		if (BAD_NAME.test(name)) throw new Error(`bitgpu/chat: tool name ${JSON.stringify(name)} contains characters that require JSON escaping (unsupported)`);
		if (seen.has(name)) throw new Error(`bitgpu/chat: duplicate tool name '${name}'`);
		seen.add(name);
		const p = t.function.parameters;
		if (p !== void 0) {
			if (p.type !== void 0 && p.type !== "object") throw new Error(`bitgpu/chat: tools[${i}].function.parameters must describe an object (got type '${p.type}')`);
			validateJsonSchema(p.type === void 0 ? {
				...p,
				type: "object"
			} : p, `tools[${i}].function.parameters`, true);
		}
	}
	if (typeof choice === "object" && !seen.has(choice.name)) throw new Error(`bitgpu/chat: toolChoice names unknown tool '${choice.name}'`);
}
/** The arguments schema the enforcer uses for a tool (parameters, defaulted to "any object"). */
function argsSchemaOf(t) {
	const p = t.function.parameters;
	if (p === void 0) return { type: "object" };
	return p.type === void 0 ? {
		...p,
		type: "object"
	} : p;
}
const utf8 = new TextEncoder();
const LIT1 = utf8.encode("{\"name\": \"");
const LIT2 = utf8.encode("\", \"arguments\": ");
const WS = /* @__PURE__ */ new Set([
	32,
	9,
	10,
	13
]);
const WS_CAP = 4;
var ToolBodyMachine = class ToolBodyMachine {
	cands;
	schemas;
	phase = 0;
	lit = 0;
	nameBuf = "";
	args = null;
	wsRun = 0;
	/** true once the closing '}' has landed (only trailing ws may follow). */
	complete = false;
	/** the committed tool name (set when its closing quote lands). */
	name = "";
	/** byte-space tool names, and each name's arguments schema */
	constructor(cands, schemas) {
		this.cands = cands;
		this.schemas = schemas;
	}
	clone() {
		const m = new ToolBodyMachine(this.cands, this.schemas);
		m.phase = this.phase;
		m.lit = this.lit;
		m.nameBuf = this.nameBuf;
		m.args = this.args ? this.args.clone() : null;
		m.wsRun = this.wsRun;
		m.complete = this.complete;
		m.name = this.name;
		return m;
	}
	static bytesOf(s) {
		return String.fromCharCode(...utf8.encode(s));
	}
	feed(bytes) {
		for (let i = 0; i < bytes.length; i++) if (!this.byte(bytes[i])) return false;
		return true;
	}
	byte(b) {
		switch (this.phase) {
			case 0:
				if (WS.has(b)) return ++this.wsRun <= WS_CAP;
				if (b !== LIT1[0]) return false;
				this.phase = 1;
				this.lit = 1;
				return true;
			case 1:
				if (b !== LIT1[this.lit]) return false;
				if (++this.lit === LIT1.length) {
					this.phase = 2;
					this.nameBuf = "";
				}
				return true;
			case 2:
				if (b === 34) {
					if (!this.cands.includes(this.nameBuf)) return false;
					this.name = this.nameBuf;
					this.phase = 3;
					this.lit = 1;
					return true;
				}
				this.nameBuf += String.fromCharCode(b);
				for (const c of this.cands) if (c.startsWith(this.nameBuf)) return true;
				return false;
			case 3:
				if (b !== LIT2[this.lit]) return false;
				if (++this.lit === LIT2.length) {
					this.phase = 4;
					this.args = new JsonMachine(this.schemas.get(this.name) ?? { type: "object" });
				}
				return true;
			case 4: {
				const a = this.args;
				if (a.complete) {
					if (WS.has(b)) return ++this.wsRun <= WS_CAP;
					if (b !== 125) return false;
					this.wsRun = 0;
					this.phase = 5;
					this.complete = true;
					return true;
				}
				return a.feed(Uint8Array.of(b));
			}
			case 5: return WS.has(b) && ++this.wsRun <= WS_CAP;
		}
	}
};
const X_FUNC = utf8.encode("<function=");
const X_PARAM = utf8.encode("<parameter=");
const X_FCLOSE = utf8.encode("</function>");
const X_PCLOSE = utf8.encode("</parameter>");
const litPrefix = (buf, lit) => {
	if (buf.length > lit.length) return false;
	for (let i = 0; i < buf.length; i++) if (buf[i] !== lit[i]) return false;
	return true;
};
const litEq = (buf, lit) => buf.length === lit.length && litPrefix(buf, lit);
var ToolBodyMachineXml = class ToolBodyMachineXml {
	cands;
	props;
	phase = 0;
	lit = 0;
	nameBuf = "";
	wsRun = 0;
	elem = [];
	keyBuf = "";
	keyCands = [];
	declared = false;
	valWs = 0;
	reqLeft = [];
	valTail = [];
	valStarted = false;
	valMode = "raw";
	valBuf = "";
	valEnum = [];
	valJson = null;
	closeLit = 0;
	complete = false;
	name = "";
	/** byte-space tool names, and per name its property keys / required subset / param schemas */
	constructor(cands, props) {
		this.cands = cands;
		this.props = props;
	}
	clone() {
		const m = new ToolBodyMachineXml(this.cands, this.props);
		m.phase = this.phase;
		m.lit = this.lit;
		m.nameBuf = this.nameBuf;
		m.wsRun = this.wsRun;
		m.elem = [...this.elem];
		m.keyBuf = this.keyBuf;
		m.keyCands = [...this.keyCands];
		m.reqLeft = [...this.reqLeft];
		m.valTail = [...this.valTail];
		m.declared = this.declared;
		m.valWs = this.valWs;
		m.valStarted = this.valStarted;
		m.complete = this.complete;
		m.name = this.name;
		m.valMode = this.valMode;
		m.valBuf = this.valBuf;
		m.valEnum = [...this.valEnum];
		m.valJson = this.valJson ? this.valJson.clone() : null;
		m.closeLit = this.closeLit;
		return m;
	}
	feed(bytes) {
		for (let i = 0; i < bytes.length; i++) if (!this.byte(bytes[i])) return false;
		return true;
	}
	forcedNext() {
		switch (this.phase) {
			case 2: return this.cands.includes(this.nameBuf) && !this.cands.some((c) => c !== this.nameBuf && c.startsWith(this.nameBuf)) ? 62 : -1;
			case 4: return this.keyCands.length > 0 && this.keyCands.includes(this.keyBuf) && !this.keyCands.some((c) => c !== this.keyBuf && c.startsWith(this.keyBuf)) ? 62 : -1;
			case 3: return this.elem.length === 0 && this.wsRun === 0 ? 10 : -1;
			case 5:
				if (this.wsRun === 0) return 10;
				if (this.valMode === "enum" && this.valEnum.includes(this.valBuf) && !this.valEnum.some((c) => c !== this.valBuf && c.startsWith(this.valBuf))) return 10;
				return -1;
			default: return -1;
		}
	}
	byte(b) {
		switch (this.phase) {
			case 0:
				if (WS.has(b)) return ++this.wsRun <= WS_CAP;
				if (b !== X_FUNC[0]) return false;
				this.phase = 1;
				this.lit = 1;
				return true;
			case 1:
				if (b !== X_FUNC[this.lit]) return false;
				if (++this.lit === X_FUNC.length) {
					this.phase = 2;
					this.nameBuf = "";
				}
				return true;
			case 2:
				if (b === 62) {
					if (!this.cands.includes(this.nameBuf)) return false;
					this.name = this.nameBuf;
					const spec = this.props.get(this.nameBuf);
					this.keyCands = [...spec?.keys ?? []];
					this.declared = this.keyCands.length > 0;
					this.reqLeft = [...spec?.required ?? []];
					this.phase = 3;
					this.elem = [];
					this.wsRun = 0;
					return true;
				}
				this.nameBuf += String.fromCharCode(b);
				for (const c of this.cands) if (c.startsWith(this.nameBuf)) return true;
				return false;
			case 3: {
				if (this.elem.length === 0 && this.wsRun === 0) {
					if (b !== 10) return false;
					this.wsRun = 1;
					return true;
				}
				this.elem.push(b);
				const canParam = this.keyCands.length > 0 || !this.declared;
				if (litEq(this.elem, X_PARAM)) {
					if (!canParam) return false;
					this.phase = 4;
					this.keyBuf = "";
					return true;
				}
				if (litEq(this.elem, X_FCLOSE)) {
					if (this.reqLeft.length) return false;
					this.phase = 7;
					this.complete = true;
					this.wsRun = 0;
					return true;
				}
				const pP = litPrefix(this.elem, X_PARAM) && canParam;
				const pF = litPrefix(this.elem, X_FCLOSE);
				if (pF && !pP && this.reqLeft.length) return false;
				return pP || pF;
			}
			case 4:
				if (b === 62) {
					if (this.keyCands.length && !this.keyCands.includes(this.keyBuf)) return false;
					this.keyCands = this.keyCands.filter((k) => k !== this.keyBuf);
					this.reqLeft = this.reqLeft.filter((k) => k !== this.keyBuf);
					this.phase = 5;
					this.valTail = [];
					this.wsRun = 0;
					this.valStarted = false;
					const sch = this.props.get(this.name)?.schemas?.get(this.keyBuf);
					const t = sch?.type;
					if (sch && (sch.oneOf !== void 0 || t !== void 0 && t !== "string")) {
						this.valMode = "json";
						this.valJson = new JsonMachine(sch);
					} else if (sch?.enum?.length) {
						this.valMode = "enum";
						this.valBuf = "";
						this.valEnum = sch.enum.map(ToolBodyMachine.bytesOf);
					} else this.valMode = "raw";
					return true;
				}
				this.keyBuf += String.fromCharCode(b);
				if (!this.keyCands.length) return true;
				for (const c of this.keyCands) if (c.startsWith(this.keyBuf)) return true;
				return false;
			case 5:
				if (this.wsRun === 0) {
					if (b !== 10) return false;
					this.wsRun = 1;
					return true;
				}
				if (!this.valStarted) {
					if (b === 10) return false;
					this.valStarted = true;
				}
				if (this.valMode === "json") {
					const j = this.valJson;
					if (j.feed(Uint8Array.of(b))) {
						if (j.complete && (b === 10 || b === 32 || b === 9 || b === 13)) {
							if (++this.valWs > 1) return false;
						} else this.valWs = 0;
						return true;
					}
					if (!j.complete || b !== X_PCLOSE[0]) return false;
					this.phase = 6;
					this.closeLit = 1;
					return true;
				}
				if (this.valMode === "enum") {
					const next = this.valBuf + String.fromCharCode(b);
					if (this.valEnum.some((c) => c.startsWith(next))) {
						this.valBuf = next;
						return true;
					}
					if (b === 10 && this.valEnum.includes(this.valBuf)) {
						this.phase = 6;
						this.closeLit = 0;
						return true;
					}
					return false;
				}
				this.valTail.push(b);
				if (this.valTail.length > X_PCLOSE.length) this.valTail.shift();
				if (litEq(this.valTail, X_PCLOSE)) {
					this.phase = 3;
					this.elem = [];
					this.wsRun = 0;
				}
				return true;
			case 6:
				if (b !== X_PCLOSE[this.closeLit]) return false;
				if (++this.closeLit === X_PCLOSE.length) {
					this.phase = 3;
					this.elem = [];
					this.wsRun = 0;
				}
				return true;
			case 7: return WS.has(b) && ++this.wsRun <= WS_CAP;
		}
	}
};
/** Per-step candidate filter for tool turns. Auto mode: free text (everything permitted) until
*  the model opens <tool_call>, then the body grammar takes over until </tool_call>, then free
*  text again (another call, prose, or eos). Forced mode: the FIRST token must be <tool_call>,
*  the body is constrained to the named tool, and after </tool_call> only eos is permitted.
*  Call advance() with each emitted token to move the real machine. */
function makeToolFilter(table, prep, startInThink = false) {
	const { ids, forced } = prep;
	const cands = (forced ? prep.tools.filter((t) => t.function.name === forced) : prep.tools).map((t) => t.function.name).map(ToolBodyMachine.bytesOf);
	const schemas = new Map(prep.tools.map((t) => [ToolBodyMachine.bytesOf(t.function.name), argsSchemaOf(t)]));
	const props = new Map(prep.tools.map((t) => {
		const p = t.function.parameters;
		const schemas = new Map(Object.entries(p?.properties ?? {}).map(([k, v]) => [ToolBodyMachine.bytesOf(k), v]));
		return [ToolBodyMachine.bytesOf(t.function.name), {
			keys: [...schemas.keys()],
			required: (p?.required ?? []).map(ToolBodyMachine.bytesOf),
			schemas
		}];
	}));
	if (prep.format === "xml") for (const t of prep.tools) for (const [k, s] of Object.entries(t.function.parameters?.properties ?? {})) {
		const sch = s;
		if (sch.oneOf === void 0 && (sch.type === void 0 || sch.type === "string") && !sch.enum?.length && (sch.minLength !== void 0 || sch.maxLength !== void 0)) throw new Error(`bitgpu/chat: minLength/maxLength on string parameter '${t.function.name}.${k}' cannot be enforced with the XML tool protocol (values are raw text); use an enum or drop the constraint`);
		if (sch.enum?.some((v) => v === "")) throw new Error(`bitgpu/chat: enum on parameter '${t.function.name}.${k}' contains an empty string, which the XML tool protocol cannot represent (the value scaffold newline would be ambiguous)`);
	}
	const newBody = () => prep.format === "xml" ? new ToolBodyMachineXml(cands, props) : new ToolBodyMachine(cands, schemas);
	const CLOSE_TEXT = ToolBodyMachine.bytesOf("</tool_call>");
	let bodyTail = "";
	let state = forced ? 1 : 0;
	let body = null;
	let inThink = startInThink;
	return {
		filter: (candidates) => {
			if (state === 0 || inThink) return Array.from(candidates, Number);
			const out = [];
			for (const id of candidates) {
				const n = Number(id);
				if (state === 1) {
					if (n === ids.open) out.push(n);
					continue;
				}
				if (state === 3) {
					if (n === ids.eos) out.push(n);
					continue;
				}
				const m = body;
				if (n === ids.close) {
					if (m.complete) out.push(n);
					continue;
				}
				const bytes = table.bytes(n);
				if (!bytes || bytes.length === 0) continue;
				if ((bodyTail + String.fromCharCode(...bytes)).includes(CLOSE_TEXT)) continue;
				const fb = m.forcedNext?.() ?? -1;
				if (fb >= 0) {
					if (bytes.length === 1 && bytes[0] === fb) out.push(n);
					continue;
				}
				if (m.clone().feed(bytes)) out.push(n);
			}
			return out;
		},
		advance: (id) => {
			if (id === ids.thinkOpen) {
				inThink = true;
				return;
			}
			if (id === ids.thinkClose) {
				inThink = false;
				return;
			}
			if (inThink) return;
			switch (state) {
				case 0:
				case 1:
					if (id === ids.open) {
						state = 2;
						body = newBody();
						bodyTail = "";
					}
					return;
				case 2:
					if (id === ids.close) {
						state = forced ? 3 : 0;
						body = null;
						return;
					}
					{
						const bytes = table.bytes(id);
						if (bytes) {
							body.feed(bytes);
							bodyTail = (bodyTail + String.fromCharCode(...bytes)).slice(1 - CLOSE_TEXT.length);
						}
					}
					return;
				case 3: return;
			}
		}
	};
}
/** Longest suffix of `s` that is a proper prefix of `tag` (what must be held back). */
function holdback(s, tag) {
	const max = Math.min(s.length, tag.length - 1);
	for (let k = max; k > 0; k--) if (tag.startsWith(s.slice(s.length - k))) return s.length - k;
	return s.length;
}
/** Stream-safe <tool_call> block extraction (the tool sibling of ThinkSplitter): visible text on
*  one channel, each COMPLETED block's content as its own string, tags never surfacing anywhere.
*  Tags can straddle token boundaries, so chunk edges hold back possible partial tags. */
var ToolCallSplitter = class {
	open;
	close;
	inside = false;
	hold = "";
	buf = "";
	constructor(open = "<tool_call>", close = "</tool_call>") {
		this.open = open;
		this.close = close;
	}
	push(chunk) {
		let s = this.hold + chunk;
		this.hold = "";
		let text = "";
		const blocks = [];
		for (;;) if (!this.inside) {
			const i = s.indexOf(this.open);
			if (i === -1) {
				const safe = holdback(s, this.open);
				text += s.slice(0, safe);
				this.hold = s.slice(safe);
				return {
					text,
					blocks
				};
			}
			text += s.slice(0, i);
			s = s.slice(i + this.open.length);
			this.inside = true;
			this.buf = "";
		} else {
			const i = s.indexOf(this.close);
			if (i === -1) {
				const safe = holdback(s, this.close);
				this.buf += s.slice(0, safe);
				this.hold = s.slice(safe);
				return {
					text,
					blocks
				};
			}
			blocks.push(this.buf + s.slice(0, i));
			this.buf = "";
			s = s.slice(i + this.close.length);
			this.inside = false;
		}
	}
	/** Emit whatever is held back. A block cut short by maxTokens surfaces as `partial` (its
	*  content never reaches the visible text). */
	flush() {
		const r = this.inside ? {
			text: "",
			blocks: [],
			partial: this.buf + this.hold
		} : {
			text: this.hold,
			blocks: [],
			partial: null
		};
		this.hold = "";
		this.buf = "";
		this.inside = false;
		return r;
	}
};
/** Parse one block's content into a ToolCall. With enforcement on this cannot fail for a
*  completed block; a failure (unenforced or truncated content) yields name '' and the raw text. */
function parseToolCall(raw) {
	try {
		const v = JSON.parse(raw.trim());
		const name = typeof v?.name === "string" ? v.name : "";
		let args = v?.arguments;
		if (typeof args === "string") args = JSON.parse(args);
		if (name && args !== null && typeof args === "object" && !Array.isArray(args)) return {
			name,
			arguments: args,
			raw
		};
	} catch {}
	return {
		name: "",
		arguments: {},
		raw
	};
}
/** Parse one XML block's content into a ToolCall (the Qwen3.5 `<function=…><parameter=…>` protocol).
*  Values are coerced by the tool's schema - string params keep their raw text, everything else is
*  JSON.parse'd. Returns name '' if the block names an unknown tool/property, a required property is
*  missing, or a non-string value is not valid JSON (so a surfaced call always conforms). */
function parseToolCallXml(raw, tools) {
	const fn = /<function=([^>]*)>/.exec(raw);
	if (!fn) return {
		name: "",
		arguments: {},
		raw
	};
	const name = fn[1];
	const tool = tools.find((t) => t.function.name === name);
	if (!tool) return {
		name: "",
		arguments: {},
		raw
	};
	const schema = tool.function.parameters;
	const props = schema?.properties ?? {};
	const args = {};
	const re = /<parameter=([^>]*)>([\s\S]*?)<\/parameter>/g;
	for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
		const key = m[1];
		const valText = m[2].replace(/^\n/, "").replace(/\n$/, "");
		const pschema = props[key];
		if (pschema?.oneOf !== void 0 || pschema?.type !== void 0 && pschema.type !== "string") try {
			args[key] = JSON.parse(valText);
		} catch {
			return {
				name: "",
				arguments: {},
				raw
			};
		}
		else args[key] = valText;
	}
	if (schema) {
		for (const req of schema.required ?? []) if (!(req in args)) return {
			name: "",
			arguments: {},
			raw
		};
		if (schema.additionalProperties === false) {
			for (const k of Object.keys(args)) if (!(k in props)) return {
				name: "",
				arguments: {},
				raw
			};
		}
	}
	return {
		name,
		arguments: args,
		raw
	};
}
//#endregion
//#region src/chat/index.ts
function deriveChatWrap(tk) {
	if (!tk.hasChatTemplate) return null;
	try {
		const render = (msgs, agp) => tk.applyChatTemplate(msgs, {
			addGenerationPrompt: agp,
			enableThinking: false
		});
		const SENT = "BITGPUSENTINEL";
		const userOnly = render([{
			role: "user",
			content: SENT
		}], false);
		const userGen = render([{
			role: "user",
			content: SENT
		}], true);
		const genPrompt = userGen.slice(userOnly.length);
		const i = userOnly.indexOf(SENT);
		if (i < 0 || !userGen.startsWith(userOnly) || !genPrompt.includes("assistant")) return null;
		const userPrefix = userOnly.slice(0, i);
		const userSuffix = userOnly.slice(i + 14);
		if (!userSuffix.includes(tk.eosToken)) return null;
		return {
			genPrompt,
			userPrefix,
			userSuffix
		};
	} catch {
		return null;
	}
}
const tcKey = (tcs) => JSON.stringify(tcs?.map((t) => [t.name, t.arguments]) ?? null);
function msgEq(a, b) {
	return a.role === b.role && a.content === b.content && tcKey(a.tool_calls) === tcKey(b.tool_calls);
}
/** True iff `next` is exactly `committed` plus one new trailing user turn - a clean append, so the
*  engine can extend its KV cache with just that turn. Compared as MESSAGES, not token ids: chat
*  templates render past assistant turns differently from live ones (e.g. Qwen3's empty <think>
*  block), so a re-tokenized history is never a token-prefix of what the cache holds. */
function isCleanAppend(committed, next) {
	if (!committed || next.length !== committed.length + 1) return false;
	if (next[next.length - 1].role !== "user") return false;
	for (let i = 0; i < committed.length; i++) if (!msgEq(next[i], committed[i])) return false;
	return true;
}
/** True iff `next` is `committed` (whose last turn is an assistant turn WITH tool calls) plus
*  only trailing `tool` result messages - the continuation leg of a tool round trip, appendable
*  to the KV cache the same way a user turn is. */
function isToolAppend(committed, next) {
	if (!committed || committed.length === 0 || next.length <= committed.length) return false;
	const last = committed[committed.length - 1];
	if (last.role !== "assistant" || !last.tool_calls?.length) return false;
	for (let i = 0; i < committed.length; i++) if (!msgEq(next[i], committed[i])) return false;
	for (let i = committed.length; i < next.length; i++) if (next[i].role !== "tool") return false;
	return true;
}
/** Load the tokenizer files and return a {@link Chat} bound to the engine. */
async function createChat(engine, options) {
	let tk;
	if (options.tokenizer) tk = new ChatTokenizer(options.tokenizer.json, options.tokenizer.config);
	else {
		const base = options.modelUrl?.replace(/\/$/, "");
		const jsonUrl = options.tokenizerJsonUrl ?? (base ? `${base}/tokenizer.json` : null);
		const cfgUrl = options.tokenizerConfigUrl ?? (base ? `${base}/tokenizer_config.json` : null);
		if (!jsonUrl || !cfgUrl) throw new Error("bitgpu/chat: provide modelUrl, tokenizerJsonUrl+tokenizerConfigUrl, or a preloaded tokenizer");
		const get = options.fetchJson ?? (async (url) => {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`bitgpu/chat: fetch ${url} failed: HTTP ${res.status}`);
			return res.json();
		});
		const [json, cfg] = await Promise.all([get(jsonUrl), get(cfgUrl)]);
		tk = new ChatTokenizer(json, cfg);
	}
	const wrap = deriveChatWrap(tk);
	const thinkPreopened = (() => {
		if (!tk.hasChatTemplate) return false;
		try {
			const r = tk.applyChatTemplate([{
				role: "user",
				content: "x"
			}], {
				addGenerationPrompt: true,
				enableThinking: true
			});
			return r.lastIndexOf("<think>") > r.lastIndexOf("</think>");
		} catch {
			return false;
		}
	})();
	let committed = null;
	let cacheEndsAtEos = false;
	let committedToolsKey = null;
	let prewarmLen = 0;
	let resetEpoch = 0;
	const dropCache = () => {
		committed = null;
		committedToolsKey = null;
		prewarmLen = 0;
		engine.resetCache();
	};
	let templateToolsOk = null;
	let toolFormat = "json";
	function prepareTools(tools, choice) {
		validateTools(tools, choice);
		if (templateToolsOk === null) try {
			const probe = tk.applyChatTemplate([{
				role: "user",
				content: "x"
			}], {
				addGenerationPrompt: false,
				tools: [{
					type: "function",
					function: { name: "bitgpu_probe_tool" }
				}]
			});
			templateToolsOk = probe.includes("bitgpu_probe_tool") && probe.includes("<tool_call>");
			toolFormat = probe.includes("<function=") ? "xml" : "json";
		} catch {
			templateToolsOk = false;
		}
		if (!templateToolsOk) throw new Error("bitgpu/chat: this model's chat template does not support tools");
		const open = tk.tokenToId("<tool_call>");
		const close = tk.tokenToId("</tool_call>");
		if (open === void 0 || close === void 0) throw new Error("bitgpu/chat: the vocabulary has no <tool_call> marker tokens, so tool calls cannot be enforced");
		return {
			tools,
			forced: typeof choice === "object" ? choice.name : null,
			format: toolFormat,
			ids: {
				open,
				close,
				eos: tk.eosTokenId,
				thinkOpen: tk.tokenToId("<think>"),
				thinkClose: tk.tokenToId("</think>")
			}
		};
	}
	let chain = Promise.resolve();
	const serialize = (fn) => {
		return (...args) => {
			const run = chain.then(() => fn(...args), () => fn(...args));
			chain = run.catch(() => void 0);
			return run;
		};
	};
	let byteTable = null;
	let dryBreakerIds = null;
	const defaultDryBreakers = () => {
		if (dryBreakerIds) return dryBreakerIds;
		const ids = /* @__PURE__ */ new Set();
		for (const t of [
			"\n",
			"\n\n",
			":",
			";",
			",",
			"\"",
			"'",
			"*",
			"-",
			"|",
			"#",
			".",
			".\n"
		]) for (const id of tk.encode(t)) ids.add(id);
		return dryBreakerIds = [...ids];
	};
	async function sendImpl(messages, o = {}) {
		if (messages.length === 0) throw new Error("bitgpu/chat: no messages");
		const json = o.format !== void 0;
		const schema = typeof o.format === "object" ? o.format.json.schema ?? null : null;
		if (schema) validateJsonSchema(schema);
		const toolsGiven = o.tools !== void 0 && o.tools.length > 0 && o.toolChoice !== "none";
		if (toolsGiven && json) throw new Error("bitgpu/chat: tools cannot be combined with format (a constrained-JSON reply has no room for tool calls)");
		const prep = toolsGiven ? prepareTools(o.tools, o.toolChoice ?? "auto") : null;
		const toolsKey = prep ? JSON.stringify(prep.tools) : null;
		const think = !json && prep?.forced == null && (o.think ?? false);
		const wantReuse = (o.reuseCache ?? true) && !think && wrap !== null && toolsKey === committedToolsKey;
		const userAppend = wantReuse && isCleanAppend(committed, messages);
		const toolAppend = wantReuse && !userAppend && isToolAppend(committed, messages);
		let canReuse = userAppend || toolAppend;
		let inputTokenIds;
		if (userAppend) {
			const w = wrap;
			const userText = messages[messages.length - 1].content;
			const deltaStr = `${cacheEndsAtEos ? "" : tk.eosToken}\n${w.userPrefix}${userText}${w.userSuffix}${w.genPrompt}`;
			inputTokenIds = tk.encode(deltaStr, false);
		} else if (toolAppend) {
			const toolMsgs = messages.slice(committed.length);
			let deltaStr = null;
			try {
				deltaStr = `${cacheEndsAtEos ? "" : tk.eosToken}\n` + tk.applyChatTemplate(toolMsgs, {
					addGenerationPrompt: true,
					enableThinking: false
				});
			} catch {
				const tools = prep?.tools;
				const fullNew = tk.applyChatTemplate(messages, {
					addGenerationPrompt: true,
					enableThinking: false,
					tools
				});
				const committedRender = tk.applyChatTemplate(committed, {
					addGenerationPrompt: false,
					enableThinking: false,
					tools
				}).replace(/\n$/, "");
				if (fullNew.startsWith(committedRender)) deltaStr = `${cacheEndsAtEos ? "" : tk.eosToken}` + fullNew.slice(committedRender.length);
			}
			if (deltaStr !== null) inputTokenIds = tk.encode(deltaStr, false);
			else {
				dropCache();
				canReuse = false;
				inputTokenIds = tk.encode(tk.applyChatTemplate(messages, {
					addGenerationPrompt: true,
					enableThinking: think,
					tools: prep?.tools
				}), false);
			}
		} else {
			dropCache();
			inputTokenIds = tk.encode(tk.applyChatTemplate(messages, {
				addGenerationPrompt: true,
				enableThinking: think,
				tools: prep?.tools
			}), false);
		}
		const decoder = tk.createDecoderStream(true);
		const splitter = new ThinkSplitter("<think>", "</think>", think && thinkPreopened);
		const stops = o.stopSequences?.length ? new StopScanner(o.stopSequences) : null;
		const stopCtl = stops ? new AbortController() : null;
		const signal = stopCtl ? o.signal ? AbortSignal.any([o.signal, stopCtl.signal]) : stopCtl.signal : o.signal;
		let text = "";
		let thinkText = "";
		const toolSplit = prep ? new ToolCallSplitter() : null;
		const toolCalls = [];
		const pushBlock = (block) => {
			const call = prep?.format === "xml" ? parseToolCallXml(block, prep.tools) : parseToolCall(block);
			toolCalls.push(call);
			if (call.name) o.onToolCall?.(call);
		};
		const emitVisible = (vis) => {
			if (!vis) return;
			const visible = stops ? stops.push(vis) : vis;
			if (visible) {
				text += visible;
				o.onText?.(visible);
			}
			if (stops?.matched) stopCtl?.abort();
		};
		const emit = (chunk) => {
			if (chunk.text) if (toolSplit) {
				const r = toolSplit.push(chunk.text);
				for (const b of r.blocks) pushBlock(b);
				emitVisible(r.text);
			} else emitVisible(chunk.text);
			if (chunk.think) {
				thinkText += chunk.think;
				o.onThink?.(chunk.think);
			}
		};
		const maxTokens = o.maxTokens ?? (think ? 1024 : 512);
		const epoch0 = resetEpoch;
		const jf = json ? makeJsonFilter(byteTable ??= new TokenByteTable(tk), tk.eosTokenId, schema) : null;
		const tf = prep ? makeToolFilter(byteTable ??= new TokenByteTable(tk), prep, think && thinkPreopened) : null;
		const tes = o.thinkEarlyStop ? {
			gap: 6,
			window: 16,
			minTokens: 64,
			...o.thinkEarlyStop === true ? {} : o.thinkEarlyStop
		} : null;
		const tb = think && (o.thinkBudget != null || tes) && tk.tokenToId("</think>") != null ? new ThinkBudget(tk.tokenToId("<think>"), tk.tokenToId("</think>"), Math.max(0, o.thinkBudget ?? Infinity), thinkPreopened, tes) : null;
		let result;
		try {
			result = await engine.generate(inputTokenIds, {
				maxTokens,
				temperature: o.temperature,
				topK: o.topK,
				topP: o.topP,
				minP: o.minP,
				repetitionPenalty: o.repetitionPenalty,
				presencePenalty: o.presencePenalty,
				dryMultiplier: o.dryMultiplier,
				dryBase: o.dryBase,
				dryAllowedLength: o.dryAllowedLength,
				dryRange: o.dryRange,
				dryBreakers: (o.dryMultiplier ?? 0) > 0 ? o.dryBreakers ?? defaultDryBreakers() : void 0,
				topNSigma: o.topNSigma,
				noRepeatNgramSize: o.noRepeatNgramSize,
				seed: o.seed,
				logprobs: o.logprobs,
				promptLookup: json || prep ? false : o.promptLookup,
				stopTokens: [tk.eosTokenId, ...o.stopTokens ?? []],
				reuseCache: canReuse,
				signal,
				candidateFilter: jf || tf || tb ? (ids, vals) => {
					tb?.observe(vals);
					const forced = tb?.force();
					if (forced != null) return [forced];
					return jf ? jf.filter(ids) : tf ? tf.filter(ids) : Array.from(ids);
				} : void 0,
				onToken: (id) => {
					tb?.advance(id);
					jf?.advance(id);
					tf?.advance(id);
					emit(splitter.push(decoder.push(id)));
				}
			});
		} catch (err) {
			if (/maxSeqLen/.test(err.message)) {
				if (o.onOverflow) {
					const trimmed = o.onOverflow({
						promptTokenCount: inputTokenIds.length,
						maxSeqLen: engine.capabilities.maxSeqLen
					});
					if (trimmed && trimmed.length > 0) {
						dropCache();
						return await sendImpl(trimmed, {
							...o,
							onOverflow: void 0,
							reuseCache: false
						});
					}
				}
			} else dropCache();
			throw err;
		}
		emit(splitter.push(decoder.flush()));
		emit(splitter.flush());
		if (toolSplit) {
			const fr = toolSplit.flush();
			for (const b of fr.blocks) pushBlock(b);
			if (fr.partial !== null) pushBlock(fr.partial);
			emitVisible(fr.text);
		}
		const aborted = o.signal?.aborted ?? false;
		const callsClean = toolCalls.every((c) => c.name !== "");
		if (aborted || stops?.matched) dropCache();
		else if (think) dropCache();
		else if (wrap !== null && (text.trim() || toolCalls.length > 0) && callsClean && resetEpoch === epoch0) {
			const assistant = {
				role: "assistant",
				content: text
			};
			if (toolCalls.length) assistant.tool_calls = toolCalls.map((c) => ({
				name: c.name,
				arguments: c.arguments
			}));
			committed = [...messages, assistant];
			committedToolsKey = toolsKey;
			cacheEndsAtEos = false;
		} else dropCache();
		return {
			text,
			thinkText,
			toolCalls,
			tokens: result.tokens,
			inputTokenIds,
			finishReason: aborted ? "abort" : stops?.matched ? "stop" : result.tokens.length >= maxTokens ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop",
			reusedCache: canReuse,
			...result.logprobs ? { logprobs: result.logprobs } : {},
			prefillMs: result.prefillMs,
			decodeMs: result.decodeMs,
			tokensPerSecond: result.tokensPerSecond
		};
	}
	const send = serialize(sendImpl);
	async function prewarmImpl(messages, opts = {}) {
		if (wrap === null) return;
		const prep = opts.tools?.length ? prepareTools(opts.tools, "auto") : null;
		const str = tk.applyChatTemplate(messages, {
			addGenerationPrompt: false,
			enableThinking: false,
			tools: prep?.tools
		}).replace(/\n$/, "");
		const toks = tk.encode(str, false);
		const epoch0 = resetEpoch;
		await engine.prefill(toks);
		if (resetEpoch !== epoch0) return;
		committed = [...messages];
		committedToolsKey = prep ? JSON.stringify(prep.tools) : null;
		prewarmLen = toks.length;
		cacheEndsAtEos = true;
	}
	return {
		send,
		stream(messages, options = {}) {
			const queue = [];
			let notify = null;
			const wake = () => {
				notify?.();
				notify = null;
			};
			let done = false;
			let result = null;
			let error = null;
			const run = send(messages, {
				...options,
				onText: (d) => {
					options.onText?.(d);
					queue.push(d);
					wake();
				}
			}).then((r) => {
				result = r;
			}).catch((e) => {
				error = e;
			}).finally(() => {
				done = true;
				wake();
			});
			async function* gen() {
				for (;;) {
					if (queue.length > 0) {
						yield queue.shift();
						continue;
					}
					if (done) break;
					await new Promise((r) => notify = r);
				}
				await run;
				if (error) throw error;
				return result;
			}
			return gen();
		},
		prewarm: serialize(prewarmImpl),
		countTokens: (messages, opts) => tk.encode(tk.applyChatTemplate(messages, {
			addGenerationPrompt: opts?.addGenerationPrompt ?? true,
			enableThinking: opts?.think ?? false,
			tools: opts?.tools
		}), false).length,
		reset: () => {
			resetEpoch++;
			dropCache();
		},
		save: serialize(async (opts) => {
			if (committed === null) return null;
			if (opts?.delta && prewarmLen <= 0) throw new Error("bitgpu/chat: save({ delta: true }) needs a prewarm() first (no shared prefix to exclude)");
			const eng = await engine.saveCache(opts?.delta ? { from: prewarmLen - 1 } : void 0);
			if (!eng) return null;
			return {
				version: 1,
				engine: eng,
				committed: JSON.parse(JSON.stringify(committed)),
				cacheEndsAtEos,
				toolsKey: committedToolsKey
			};
		}),
		restore: serialize(async (snap) => {
			if (!snap || snap.version !== 1) throw new Error("bitgpu/chat: unsupported chat snapshot version");
			if (!Array.isArray(snap.committed) || snap.committed.length === 0) throw new Error("bitgpu/chat: chat snapshot holds no committed transcript");
			await engine.restoreCache(snap.engine);
			resetEpoch++;
			committed = JSON.parse(JSON.stringify(snap.committed));
			committedToolsKey = snap.toolsKey ?? null;
			cacheEndsAtEos = !!snap.cacheEndsAtEos;
			if (!snap.engine.base) prewarmLen = 0;
		}),
		eosTokenId: tk.eosTokenId,
		tokenizer: tk
	};
}
//#endregion
export { ChatTokenizer, JsonMachine, StopScanner, ThinkBudget, ThinkSplitter, ToolBodyMachine, ToolBodyMachineXml, ToolCallSplitter, createChat, makeToolFilter, parseToolCall, parseToolCallXml, validateJsonSchema, validateTools };

