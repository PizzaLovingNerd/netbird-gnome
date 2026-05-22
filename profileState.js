import GLib from 'gi://GLib';


const NETBIRD_PROFILE_STATE_DIR = 'netbird';


export function readProfileEmail(profileName) {
    if (!profileName)
        return '';

    const statePath = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        NETBIRD_PROFILE_STATE_DIR,
        `${profileName}.state.json`,
    ]);

    try {
        const [ok, contents] = GLib.file_get_contents(statePath);
        if (!ok)
            return '';

        const profileState = JSON.parse(new TextDecoder().decode(contents));
        return typeof profileState.email === 'string' ? profileState.email.trim() : '';
    } catch {
        return '';
    }
}
