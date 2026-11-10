import * as React from "react";
import * as ReactDOM from "react-dom";
import { App, Modal } from "obsidian";

type RenderCallback = (
    close: () => void
) => Promise<ReturnType<typeof React.createElement>>;
export default class ReactModal<Props, Component> extends Modal {
    onOpenCallback: RenderCallback;

    constructor(app: App, onOpenCallback: RenderCallback) {
        super(app);
        this.onOpenCallback = onOpenCallback;
    }

    async onOpen() {
        const { contentEl } = this;
        // Scope for this plugin's modal styling. Obsidian's bare `select`
        // rule fills form controls with `--interactive-normal` (the grey it
        // also uses for disabled), and a plugin can't restyle `select`
        // globally without touching Obsidian's own modals.
        contentEl.addClass("ofc-modal");
        ReactDOM.render(
            await this.onOpenCallback(() => this.close()),
            contentEl
        );
    }

    onClose() {
        const { contentEl } = this;
        ReactDOM.unmountComponentAtNode(contentEl);
    }
}
