'use strict';

// ============================================================================
// Settings Profiles
// ============================================================================

import {EventEmitter} from 'utilities/events';
import {isValidShortcut, has} from 'utilities/object';
import {createTester} from 'utilities/filtering';

const fetchJSON = (url, options) => fetch(url, options).then(r => r.ok ? r.json() : null).catch(() => null);

/**
 * Instances of SettingsProfile are used for getting and setting raw settings
 * values, enumeration, and emit events when the raw settings are changed.
 * @extends EventEmitter
 */
export default class SettingsProfile extends EventEmitter {
	constructor(manager, data) {
		super();

		this.onShortcut = this.onShortcut.bind(this);
		this._hotkey_enabled = false;

		this.manager = manager;
		this.provider = manager.provider;

		this.data = data;
		this.prefix = `p:${this.id}:`;
		this.enabled_key = `${this.prefix}:enabled`;

		if ( this.ephemeral ) {
			this._enabled = true;
			this._storage = new Map;
		}
	}

	get data() {
		return {
			id: this.id,
			parent: this.parent,

			name: this.name,
			i18n_key: this.i18n_key,
			hotkey: this.hotkey,
			pause_updates: this.pause_updates,

			ephemeral: this.ephemeral,

			description: this.description,
			desc_i18n_key: this.desc_i18n_key,

			url: this.url,
			show_toggle: this.show_toggle,

			context: this.context
		}
	}

	set data(val) {
		if ( typeof val !== 'object' )
			throw new TypeError('data must be an object');

		this.matcher = null;

		for(const key in val)
			if ( has(val, key) )
				this[key] = val[key];
	}

	matches(context) {
		if ( ! this.matcher )
			this.matcher = createTester(this.context, this.manager.filters, false, false, () => this.manager.updateSoon());

		return this.matcher(context);
	}


	save() {
		if ( ! this.ephemeral )
			this.manager.saveProfile(this.id);
	}


	getBackup() {
		const out = {
			version: 2,
			type: 'profile',
			profile: this.data,
			toggled: this.toggled,
			values: {}
		};

		delete out.profile.ephemeral;

		for(const [k,v] of this.entries())
			out.values[k] = v;

		return out;
	}


	async checkUpdate() {
		if ( ! this.url || this.pause_updates )
			return false;

		const data = await fetchJSON(this.url);
		if ( ! data || ! data.type === 'profile' || ! data.profile || ! data.values )
			return false;

		// We don't want to override general settings.
		delete data.profile.ephemeral;
		delete data.profile.id;
		delete data.profile.name;
		delete data.profile.i18n_key;
		delete data.profile.hotkey;
		delete data.profile.description;
		delete data.profile.desc_i18n_key;
		delete data.profile.url;
		delete data.profile.pause_updates;

		this.data = data.profile;

		const old_keys = new Set(this.keys());

		for(const [key, value] of Object.entries(data.values)) {
			old_keys.delete(key);
			this.set(key, value);
		}

		for(const key of old_keys)
			this.delete(key);

		return true;
	}


	// ========================================================================
	// Hotkey
	// ========================================================================

	get hotkey() {
		return this._hotkey;
	}

	set hotkey(key) {
		if ( key === this._hotkey )
			return;

		this._hotkey = key;
		if ( this._hotkey_enabled )
			this._updateHotkey();
	}

	get hotkey_enabled() {
		return this._hotkey_enabled;
	}

	set hotkey_enabled(val) {
		this._hotkey_enabled = !! val;
		this._updateHotkey();
	}

	_updateHotkey() {
		const Mousetrap = this.Mousetrap = this.Mousetrap || window.Mousetrap;
		if ( ! Mousetrap )
			return;

		const key = this._hotkey;

		if ( this._bound_key && (this._bound_key !== key || ! this._hotkey_enabled) ) {
			Mousetrap.unbind(this._bound_key);
			this._bound_key = null;
		}

		if ( ! this._hotkey_enabled )
			return;

		if ( key && isValidShortcut(key) ) {
			Mousetrap.bind(key, this.onShortcut);
			this._bound_key = key;
		}
	}

	onShortcut(e) {
		this.toggled = ! this.toggled;

		if ( e ) {
			e.stopPropagation();
			e.preventDefault();
		}
	}


	// ========================================================================
	// Toggled
	// ========================================================================

	get toggled() {
		if ( this.ephemeral )
			return this._enabled;
		return this.provider.get(this.enabled_key, true);
	}

	set toggled(val) {
		if ( val === this.toggleState )
			return;

		if ( this.ephemeral )
			this._enabled = val;
		else
			this.provider.set(this.enabled_key, val);

		this.emit('toggled', this, val);
	}


	// ========================================================================
	// Context
	// ========================================================================

	updateContext(context) {
		if ( this.id === 0 )
			throw new Error('cannot set context of default profile');

		this.context = Object.assign(this.context || {}, context);
		this.matcher = null;
		this.manager._saveProfiles();
	}

	setContext(context) {
		if ( this.id === 0 )
			throw new Error('cannot set context of default profile');

		this.context = context;
		this.matcher = null;
		this.manager._saveProfiles();
	}


	// ========================================================================
	// Setting Access
	// ========================================================================

	get(key, default_value) {
		if ( this.ephemeral )
			return this._storage.get(key, default_value);
		return this.provider.get(this.prefix + key, default_value);
	}

	set(key, value) {
		if ( this.ephemeral )
			this._storage.set(key, value);
		else
			this.provider.set(this.prefix + key, value);
		this.emit('changed', key, value);
	}

	delete(key) {
		if ( this.ephemeral )
			this._storage.delete(key);
		else
			this.provider.delete(this.prefix + key);
		this.emit('changed', key, undefined, true);
	}

	has(key) {
		if ( this.ephemeral )
			return this._storage.has(key);
		return this.provider.has(this.prefix + key);
	}

	keys() {
		if ( this.ephemeral )
			return Array.from(this._storage.keys());

		const out = [],
			p = this.prefix,
			len = p.length;

		for(const key of this.provider.keys())
			if ( key.startsWith(p) && key !== this.enabled_key )
				out.push(key.slice(len));

		return out;
	}

	clear() {
		if ( this.ephemeral ) {
			const keys = this.keys();
			this._storage.clear();
			for(const key of keys) {
				this.emit('changed', key, undefined, true);
			}
			return;
		}

		const p = this.prefix,
			len = p.length;
		for(const key of this.provider.keys())
			if ( key.startsWith(p) && key !== this.enabled_key ) {
				this.provider.delete(key);
				this.emit('changed', key.slice(len), undefined, true);
			}
	}

	*entries() {
		if ( this.ephemeral ) {
			for(const entry of this._storage.entries())
				yield entry;

		} else {
			const p = this.prefix,
				len = p.length;

			for(const key of this.provider.keys())
				if ( key.startsWith(p) && key !== this.enabled_key )
					yield [key.slice(len), this.provider.get(key)];
		}
	}

	get size() {
		if ( this.ephemeral )
			return this._storage.size;

		const p = this.prefix;
		let count = 0;

		for(const key of this.provider.keys())
			if ( key.startsWith(p) && key !== this.enabled_key )
				count++;

		return count;
	}
}


SettingsProfile.Default = {
	id: 0,
	name: 'Default Profile',
	i18n_key: 'setting.profiles.default',

	description: 'Settings that apply everywhere on Twitch.'
}


SettingsProfile.Moderation = {
	id: 1,
	name: 'Moderation',
	i18n_key: 'setting.profiles.moderation',

	description: 'Settings that apply when you are a moderator of the current channel.',

	context: [
		{
			type: 'Moderator',
			data: true
		}
	]
}