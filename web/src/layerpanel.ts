import type { HUD } from './hud';
import { has, onLang, t } from './i18n';
import { loadBaked, parseUpload, type PointLayer } from './layers';
import type { PoiLayer } from './pois';
import type { World } from './world';

/**
 * The data layers panel: a checkbox per layer, a button and a drop target
 * for adding files. The mouse is captured while playing, so using it means
 * Esc first; dropping a file works at any time.
 */
export class LayerPanel {
  private readonly el = document.getElementById('layers')!;
  private readonly list = document.getElementById('layerlist')!;
  private readonly picker = document.getElementById('layerfile') as HTMLInputElement;

  constructor(private readonly pois: PoiLayer, private readonly world: World,
              private readonly hud: HUD) {
    document.getElementById('layeradd')!.addEventListener('click', () => this.picker.click());
    this.picker.addEventListener('change', () => {
      void this.addFiles([...this.picker.files ?? []]);
      this.picker.value = '';
    });
    // the whole window is a drop target
    addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
    addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) document.body.classList.remove('dragging');
    });
    addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      void this.addFiles([...e.dataTransfer?.files ?? []]);
    });
  }

  async load(): Promise<this> {
    onLang(() => this.render());
    for (const l of await loadBaked()) this.pois.addLayer(l);
    this.render();
    return this;
  }

  toggle(): boolean {
    return !this.el.classList.toggle('closed');
  }

  private async addFiles(files: File[]): Promise<void> {
    for (const f of files) {
      try {
        const { layer, outside } = await parseUpload(f, this.world.origin);
        this.pois.addLayer(layer);
        const inside = layer.points.filter((p) => this.world.covers(p.x, p.z)).length;
        const notes = [
          inside < layer.points.length ? t('layers.inArea', { n: inside }) : '',
          outside ? t('layers.outside', { n: outside }) : '',
        ].filter(Boolean);
        this.hud.hint(t('layers.added', { name: layer.name, n: layer.points.length })
          + (notes.length ? ` (${notes.join(', ')})` : ''), 4);
      } catch (err) {
        this.hud.hint(`${f.name}: ${(err as Error).message}`, 6);
      }
    }
    this.el.classList.remove('closed');
    this.render();
  }

  private render(): void {
    this.list.replaceChildren(...[...this.pois.layers.values()].map((l) => this.row(l)));
    if (!this.pois.layers.size) this.list.textContent = t('layers.none');
  }

  private row(l: PointLayer): HTMLElement {
    const row = document.createElement('label');
    row.className = 'layer';
    if (l.attribution) row.title = l.attribution;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = l.on;
    box.addEventListener('change', () => { l.on = box.checked; });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = l.colour;
    const name = document.createElement('span');
    name.className = 'lname';
    // baked layers have a name in each language; uploads keep their file name
    name.textContent = !l.uploaded && has(`layer.${l.id}`) ? t(`layer.${l.id}`) : l.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(l.points.length);
    row.append(box, swatch, name, count);
    if (l.uploaded) {
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = t('layers.remove');
      del.addEventListener('click', (e) => {
        e.preventDefault();
        this.pois.removeLayer(l.id);
        this.render();
      });
      row.append(del);
    }
    return row;
  }
}
