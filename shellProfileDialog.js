import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';


export class ProfileNameDialog extends ModalDialog.ModalDialog {
    constructor({
        onAccept,
        onClose,
    } = {}) {
        super({destroyOnClose: true});

        this._onAccept = onAccept;
        this._onClose = onClose;
        this._closed = false;

        const title = new St.Label({
            text: 'Add Profile',
            style_class: 'headline',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const description = new St.Label({
            text: 'Enter a name for the new NetBird profile.',
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._entry = new St.Entry({
            can_focus: true,
            hint_text: 'Profile name',
            style_class: 'modal-dialog-entry',
            x_expand: true,
        });

        this.contentLayout.add_child(title);
        this.contentLayout.add_child(description);
        this.contentLayout.add_child(this._entry);
        this.setInitialKeyFocus(this._entry);

        this._addButton = this.addButton({
            action: () => this._accept(),
            default: true,
            label: 'Add',
        });
        this.addButton({
            action: () => this.close(),
            key: Clutter.KEY_Escape,
            label: 'Cancel',
        });
        this._addButton.reactive = false;
        this._addButton.can_focus = false;

        this._entry.clutter_text.connect('text-changed', () => {
            const enabled = this._entry.get_text().trim().length > 0;
            this._addButton.reactive = enabled;
            this._addButton.can_focus = enabled;
        });
        this._entry.clutter_text.connect('activate', () => this._accept());
        this.connect('closed', () => {
            if (this._closed)
                return;

            this._closed = true;
            this._onClose?.();
            this._onAccept = null;
            this._onClose = null;
        });
    }

    _accept() {
        const profileName = this._entry.get_text().trim();
        if (!profileName)
            return;

        const onAccept = this._onAccept;
        this.close();
        onAccept?.(profileName);
    }

    destroy() {
        this._onAccept = null;
        this._onClose = null;
        super.destroy();
    }
}
