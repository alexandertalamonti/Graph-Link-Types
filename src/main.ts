import { Plugin, App, PluginSettingTab, Setting} from 'obsidian';
import { getAPI } from 'obsidian-dataview';
import { ObsidianRenderer, ObsidianLink} from 'src/types';
import { LinkManager } from 'src/linkManager';

export interface GraphLinkTypesPluginSettings {
    tagColors: boolean;
    tagNames: boolean;
    tagLegend: boolean;
}

const DEFAULT_SETTINGS: GraphLinkTypesPluginSettings = {
    tagColors: false, // By default, the feature is enabled
    tagNames: true,
    tagLegend: true,
};

class GraphLinkTypesSettingTab extends PluginSettingTab {
    plugin: GraphLinkTypesPlugin;

    constructor(app: App, plugin: GraphLinkTypesPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
    
        new Setting(containerEl)
            .setName('Type Names')
            .setDesc('Toggle to enable or disable link type names in the graph view.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.tagNames)
                .onChange(async (value) => {
                    this.plugin.settings.tagNames = value;
                    await this.plugin.saveSettings();
                    this.plugin.startUpdateLoop();
                }));
    
        new Setting(containerEl)
            .setName('Type Colors')
            .setDesc('Toggle to enable or disable link type colors in the graph view.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.tagColors)
                .onChange(async (value) => {
                    this.plugin.settings.tagColors = value;
                    await this.plugin.saveSettings();
                    this.plugin.startUpdateLoop();
                }));
    
        // Define the nested setting for the legend
        new Setting(containerEl)
            .setName('Show Legend')
            .setDesc('Toggle to show or hide the legend for link type colors in the graph view.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.tagLegend)
                .onChange(async (value) => {
                    this.plugin.settings.tagLegend = value;
                    await this.plugin.saveSettings();
                    this.plugin.startUpdateLoop();
                }));
    }
}


export default class GraphLinkTypesPlugin extends Plugin {
    
    settings: GraphLinkTypesPluginSettings;
    api: ReturnType<typeof getAPI> = null;
    currentRenderer: ObsidianRenderer | null = null;
    animationFrameId: number | null = null;
    private metadataTimerId: number | null = null;
    private rendererRetryId: number | null = null;
    private rendererRetryCount = 0;
    private syncTimeoutId: number | null = null;
    private syncInProgress = false;
    private syncQueued = false;
    private graphViewListeners = new Map<HTMLElement, EventListener>();
    linkManager = new LinkManager();
    indexReady = false;

    // Lifecycle method called when the plugin is loaded
    async onload(): Promise<void> {

        await this.loadSettings();
        this.addSettingTab(new GraphLinkTypesSettingTab(this.app, this));
        this.addCommand({
            id: 'refresh-graph-link-labels',
            name: 'Refresh graph link labels',
            callback: () => {
                this.linkManager.clearMetadataCache();
                if (this.currentRenderer) this.startUpdateLoop();
                else this.handleLayoutChange();
            },
        });
        this.app.workspace.onLayoutReady(() => this.handleLayoutChange());

        // Try to get Dataview API — may not be ready yet if Dataview
        // loads after this plugin (class field initializers run before
        // any lifecycle method, so getAPI() at construction time fails)
        this.api = getAPI();
        if (!this.api) {
            // Dataview not ready yet — wait for its API registration event
            // @ts-ignore
            this.registerEvent(this.app.metadataCache.on("dataview:api-ready", () => {
                this.api = getAPI();
                this.linkManager.api = this.api;
                this.initEventHandlers();
                this.handleLayoutChange();
            }));
            return;
        }

        this.linkManager.api = this.api;
        this.initEventHandlers();
        this.handleLayoutChange();
    }

    private initEventHandlers(): void {
        // Handle layout changes
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            this.handleLayoutChange();
        }));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.handleLayoutChange()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.handleLayoutChange()));
        this.registerEvent(this.app.metadataCache.on('resolved', () => this.scheduleSync(200)));

        // @ts-ignore
        this.registerEvent(this.app.metadataCache.on("dataview:index-ready", () => {
            this.indexReady = true;
            this.scheduleMetadataRefresh();
        }));

        // @ts-ignore
        this.registerEvent(this.app.metadataCache.on("dataview:metadata-change", () => {
            if (this.indexReady) this.scheduleMetadataRefresh();
        }));
    }

    private scheduleMetadataRefresh(): void {
        if (this.metadataTimerId !== null) window.clearTimeout(this.metadataTimerId);
        this.metadataTimerId = window.setTimeout(() => {
            this.metadataTimerId = null;
            this.linkManager.clearMetadataCache();
            if (this.currentRenderer) this.startUpdateLoop();
        }, 250);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Find the first valid graph renderer in the workspace
    findRenderer(): ObsidianRenderer | null {
        let graphLeaves = this.app.workspace.getLeavesOfType('graph');
        for (const leaf of graphLeaves) {
            // @ts-ignore
            const renderer = leaf.view.renderer;
            if (this.isObsidianRenderer(renderer)) {
                return renderer;
            }
        }

        graphLeaves = this.app.workspace.getLeavesOfType('localgraph');
        for (const leaf of graphLeaves) {
            // @ts-ignore
            const renderer = leaf.view.renderer;
            if (this.isObsidianRenderer(renderer)) {
                return renderer;
            }
        }
        return null;
    }
    
    handleLayoutChange(): void {
        if (!this.api) return;
        this.refreshGraphViewListeners();
        this.rendererRetryCount = 0;
        this.checkAndUpdateRenderer();
    }

    private refreshGraphViewListeners(): void {
        const leaves = [
            ...this.app.workspace.getLeavesOfType('graph'),
            ...this.app.workspace.getLeavesOfType('localgraph'),
        ];
        const currentElements = new Set(leaves.map(leaf => leaf.view.containerEl));
        for (const [element, listener] of this.graphViewListeners) {
            if (currentElements.has(element)) continue;
            for (const type of ['input', 'change', 'click']) element.removeEventListener(type, listener);
            this.graphViewListeners.delete(element);
        }
        for (const element of currentElements) {
            if (this.graphViewListeners.has(element)) continue;
            const listener: EventListener = () => this.scheduleSync(200);
            for (const type of ['input', 'change', 'click']) element.addEventListener(type, listener);
            this.graphViewListeners.set(element, listener);
        }
    }

    checkAndUpdateRenderer(): void {
        const newRenderer = this.findRenderer();
        if (newRenderer && newRenderer === this.currentRenderer) {
            this.scheduleSync(200);
            return;
        }
        this.stopUpdateLoop();
        if (this.currentRenderer) this.linkManager.destroyMap(this.currentRenderer);
        this.currentRenderer = newRenderer;
        if (!newRenderer) {
            // Graph views sometimes create their renderer after layout-change.
            if (this.rendererRetryId !== null) window.clearTimeout(this.rendererRetryId);
            if (this.rendererRetryCount++ < 20 &&
                (this.app.workspace.getLeavesOfType('graph').length || this.app.workspace.getLeavesOfType('localgraph').length)) {
                this.rendererRetryId = window.setTimeout(() => {
                    this.rendererRetryId = null;
                    this.checkAndUpdateRenderer();
                }, 500);
            }
            return;
        }
        if (this.rendererRetryId !== null) window.clearTimeout(this.rendererRetryId);
        this.rendererRetryId = null;
        newRenderer.px.stage.sortableChildren = true;
        this.startUpdateLoop();
    }

    startUpdateLoop(): void {
        if (!this.currentRenderer) return;
        this.stopUpdateLoop();
        this.linkManager.destroyMap(this.currentRenderer);
        if (!this.settings.tagNames && !this.settings.tagColors) return;
        this.scheduleSync(0);
    }

    private scheduleSync(delay: number): void {
        if (!this.currentRenderer || (!this.settings.tagNames && !this.settings.tagColors)) return;
        if (this.syncInProgress) {
            this.syncQueued = true;
            return;
        }
        if (this.syncTimeoutId !== null) window.clearTimeout(this.syncTimeoutId);
        this.syncTimeoutId = window.setTimeout(() => this.syncLinks(), delay);
    }

    private stopUpdateLoop(): void {
        if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
        if (this.syncTimeoutId !== null) window.clearTimeout(this.syncTimeoutId);
        this.animationFrameId = null;
        this.syncTimeoutId = null;
        this.syncInProgress = false;
        this.syncQueued = false;
    }

    private syncLinks(): void {
        const renderer = this.currentRenderer;
        if (!renderer || this.syncInProgress) return;
        this.syncTimeoutId = null;
        this.syncInProgress = true;
        const links = renderer.links.slice();
        const currentLinks: ObsidianLink[] = [];
        let index = 0;
        const processBatch = () => {
            if (renderer !== this.currentRenderer || !this.syncInProgress) return;
            const deadline = performance.now() + 6;
            while (index < links.length && performance.now() < deadline) {
                const link = links[index++];
                if (!link?.source?.id || !link?.target?.id) continue;
                currentLinks.push(link);
                const key = this.linkManager.generateKey(link.source.id, link.target.id);
                if (!this.linkManager.linksMap.has(key)) {
                    this.linkManager.addLink(renderer, link, this.settings.tagNames, this.settings.tagColors, this.settings.tagLegend);
                } else {
                    this.linkManager.linksMap.get(key)!.obsidianLink = link;
                }
            }
            if (index < links.length) {
                this.syncTimeoutId = window.setTimeout(processBatch, 0);
                return;
            }
            this.syncTimeoutId = null;
            this.syncInProgress = false;
            this.linkManager.removeLinks(renderer, currentLinks);
            if (this.linkManager.linksMap.size > 0 && this.animationFrameId === null) {
                this.animationFrameId = requestAnimationFrame(() => this.updatePositions());
            }
            if (this.syncQueued) {
                this.syncQueued = false;
                this.scheduleSync(0);
            }
        };
        processBatch();
    }

    private updatePositions(): void {
        const renderer = this.currentRenderer;
        if (!renderer) return;
        for (const gltLink of this.linkManager.linksMap.values()) {
            this.linkManager.updateLinkText(renderer, gltLink.obsidianLink, this.settings.tagNames);
            if (this.settings.tagColors) this.linkManager.updateLinkGraphics(renderer, gltLink.obsidianLink);
        }
        this.animationFrameId = this.linkManager.linksMap.size > 0
            ? requestAnimationFrame(() => this.updatePositions()) : null;
    }

    onunload(): void {
        this.stopUpdateLoop();
        if (this.metadataTimerId !== null) window.clearTimeout(this.metadataTimerId);
        if (this.rendererRetryId !== null) window.clearTimeout(this.rendererRetryId);
        if (this.currentRenderer) this.linkManager.destroyMap(this.currentRenderer);
        for (const [element, listener] of this.graphViewListeners) {
            for (const type of ['input', 'change', 'click']) element.removeEventListener(type, listener);
        }
        this.graphViewListeners.clear();
        this.linkManager.dispose();
    }

    private isObsidianRenderer(renderer: any): renderer is ObsidianRenderer {
        return renderer 
            && renderer.px 
            && renderer.px.stage 
            && typeof renderer.panX === 'number'
            && typeof renderer.panY === 'number'
            && typeof renderer.px.stage.addChild === 'function' 
            && typeof renderer.px.stage.removeChild === 'function'
            && Array.isArray(renderer.links);
    }

}
