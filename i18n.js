import Gettext from 'gettext';
import GLib from 'gi://GLib';


const GETTEXT_DOMAIN = 'netbird-gnome';
const extensionDir = GLib.getenv('NETBIRD_GNOME_EXTENSION_DIR');

if (extensionDir) {
    Gettext.bindtextdomain(
        GETTEXT_DOMAIN,
        GLib.build_filenamev([extensionDir, 'locale']));
}

const domain = Gettext.domain(GETTEXT_DOMAIN);

export const _ = domain.gettext;
export const ngettext = domain.ngettext;
