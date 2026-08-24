import { MixerFX, FxParamValue, WetDry } from './base';

/**
 * PLUGIN — one of YOUR VST3 / Audio Unit effects, in the insert chain (Terminator 3.0, Phase 6.2).
 *
 * The audio is the ENGINE's: the app hosts the real plugin and hands the C++ mixer a pointer to it
 * (engine/core/fx/PluginFx.h), so this page object is a documented PASS-THROUGH, exactly like the premium devices.
 * What it DOES carry is the choice: `PLUGIN` is the plugin's identifier and `STATE` its own saved settings, and
 * because both are ordinary params they travel with the chain — copy the slot, save the project, load it again
 * tomorrow and the same plugin comes back the way you left it.
 */
export class PluginFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  params: Record<string, FxParamValue> = {
    WET: 100,
    PLUGIN: '', // PluginDescription::createIdentifierString() — '' = an empty slot, which passes audio
    STATE: '',  // the plugin's own state, base64 (written back when the project is saved)
  };
  private wd: WetDry;

  constructor(ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.wd.wetIn.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = typeof value === 'string' ? value : Number(value);
    if (key === 'WET') this.wd.setMix(Number(value) / 100);
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  dispose(): void { this.wd.disconnect(); }
}
