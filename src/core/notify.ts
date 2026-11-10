/*
 * Telling the user something, from code that doesn't know what it runs in.
 * The core calls `notify`; the host decides what that looks like — a toast
 * in Obsidian (see main.ts), something else in another app. Until a host
 * registers, messages go to the console so nothing is silently lost.
 */

type Notifier = (message: string) => void;

let sink: Notifier = (message) => console.warn(message);

export function setNotifier(notifier: Notifier): void {
    sink = notifier;
}

export function notify(message: string): void {
    sink(message);
}
