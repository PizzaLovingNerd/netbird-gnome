import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {_} from './i18n.js';

export function presentAlertDialog(dialog, parent) {
    if (parent) {
        dialog.present(parent);
        return;
    }

    const host = new Adw.Window({
        title: 'NetBird',
        modal: true,
        default_width: 420,
        default_height: 1,
        resizable: false,
    });

    dialog.connect('closed', () => {
        host.destroy();
    });

    host.present();
    dialog.present(host);
}

export function confirmProfileDeregister({
    parent = null,
    profileName,
    onAccept,
} = {}) {
    const dialog = new Adw.AlertDialog({
        heading: _('Deregister Profile?'),
        body: _('Sign out of "%s" and remove this device from the NetBird management service.')
            .replace('%s', profileName),
        close_response: 'cancel',
        default_response: 'cancel',
    });

    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('deregister', _('Deregister'));
    dialog.set_response_appearance('deregister', Adw.ResponseAppearance.DESTRUCTIVE);

    dialog.connect('response', (_source, response) => {
        if (response !== 'deregister')
            return;

        onAccept?.();
    });

    presentAlertDialog(dialog, parent);
}

export function promptProfileName({
    parent = null,
    onAccept,
} = {}) {
    const entry = new Gtk.Entry({
        placeholder_text: _('Profile name'),
        activates_default: true,
    });

    const dialog = new Adw.AlertDialog({
        heading: _('Add Profile'),
        body: _('Enter a name for the new NetBird profile.'),
        extra_child: entry,
        close_response: 'cancel',
        default_response: 'add',
    });

    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('add', _('Add'));
    dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_response_enabled('add', false);

    entry.connect('notify::text', () => {
        dialog.set_response_enabled('add', entry.text.trim() !== '');
    });

    dialog.connect('response', (_source, response) => {
        if (response !== 'add')
            return;

        const profileName = entry.text.trim();
        if (!profileName)
            return;

        onAccept?.(profileName);
    });

    presentAlertDialog(dialog, parent);
    entry.grab_focus();
}
