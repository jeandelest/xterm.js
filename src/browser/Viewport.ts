/**
 * Copyright (c) 2024 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { ICoreBrowserService, IRenderService, IThemeService } from 'browser/services/Services';
import { ViewportConstants } from 'browser/shared/Constants';
import { EventEmitter, runAndSubscribe } from 'common/EventEmitter';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { IBufferService, IOptionsService } from 'common/services/Services';
import { scheduleAtNextAnimationFrame } from 'vs/base/browser/dom';
import { SmoothScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import type { ScrollableElementChangeOptions } from 'vs/base/browser/ui/scrollbar/scrollableElementOptions';
import { Scrollable, ScrollbarVisibility, type ScrollEvent } from 'vs/base/common/scrollable';

export class Viewport extends Disposable {

  protected _onRequestScrollLines = this.register(new EventEmitter<number>());
  public readonly onRequestScrollLines = this._onRequestScrollLines.event;

  private _scrollableElement: SmoothScrollableElement;
  private _styleElement: HTMLStyleElement;

  private _queuedAnimationFrame?: number;
  private _latestYDisp?: number;
  private _isSyncing: boolean = false;
  private _isHandlingScroll: boolean = false;
  private _suppressOnScrollHandler: boolean = false;

  constructor(
    element: HTMLElement,
    screenElement: HTMLElement,
    @IBufferService private readonly _bufferService: IBufferService,
    @ICoreBrowserService coreBrowserService: ICoreBrowserService,
    @IThemeService themeService: IThemeService,
    @IOptionsService private readonly _optionsService: IOptionsService,
    @IRenderService private readonly _renderService: IRenderService
  ) {
    super();

    // TODO: Support smooth scroll

    const scrollable = this.register(new Scrollable({
      forceIntegerValues: false,
      smoothScrollDuration: this._optionsService.rawOptions.smoothScrollDuration,
      // This is used over `IRenderService.addRefreshCallback` since it can be canceled
      scheduleAtNextAnimationFrame: cb => scheduleAtNextAnimationFrame(coreBrowserService.window, cb)
    }));
    this.register(this._optionsService.onSpecificOptionChange('smoothScrollDuration', () => {
      scrollable.setSmoothScrollDuration(this._optionsService.rawOptions.smoothScrollDuration);
    }));

    this._scrollableElement = this.register(new SmoothScrollableElement(screenElement, {
      vertical: ScrollbarVisibility.Auto,
      horizontal: ScrollbarVisibility.Hidden,
      useShadows: false,
      mouseWheelSmoothScroll: true,
      ...this._getChangeOptions()
    }, scrollable));
    this.register(this._optionsService.onMultipleOptionChange([
      'scrollSensitivity',
      'fastScrollSensitivity',
      'overviewRulerWidth'
    ], () => this._scrollableElement.updateOptions(this._getChangeOptions())));

    this._scrollableElement.setScrollDimensions({ height: 0, scrollHeight: 0 });
    this.register(runAndSubscribe(themeService.onChangeColors, () => {
      this._scrollableElement.getDomNode().style.backgroundColor = themeService.colors.background.css;
    }));
    element.appendChild(this._scrollableElement.getDomNode());
    this.register(toDisposable(() => this._scrollableElement.getDomNode().remove()));

    this._styleElement = coreBrowserService.window.document.createElement('style');
    screenElement.appendChild(this._styleElement);
    this.register(toDisposable(() => this._styleElement.remove()));
    this.register(runAndSubscribe(themeService.onChangeColors, () => {
      this._styleElement.textContent = [
        `.xterm .xterm-scrollable-element > .scrollbar > .slider {`,
        `  background: ${themeService.colors.scrollbarSliderBackground.css};`,
        `}`,
        `.xterm .xterm-scrollable-element > .scrollbar > .slider:hover {`,
        `  background: ${themeService.colors.scrollbarSliderHoverBackground.css};`,
        `}`,
        `.xterm .xterm-scrollable-element > .scrollbar > .slider.active {`,
        `  background: ${themeService.colors.scrollbarSliderActiveBackground.css};`,
        `}`
      ].join('\n');
    }));

    this.register(this._bufferService.onResize(() => this._queueSync()));
    this.register(this._bufferService.onScroll(() => this._sync()));

    this.register(this._scrollableElement.onScroll(e => this._handleScroll(e)));
  }

  public scrollLines(disp: number): void {
    const pos = this._scrollableElement.getScrollPosition();
    this._scrollableElement.setScrollPosition({
      reuseAnimation: true,
      scrollTop: pos.scrollTop + disp * this._renderService.dimensions.css.cell.height
    });
  }

  public scrollToLine(line: number, disableSmoothScroll?: boolean): void {
    if (!disableSmoothScroll) {
      this._latestYDisp = line;
    }
    this._scrollableElement.setScrollPosition({
      reuseAnimation: !disableSmoothScroll,
      scrollTop: line * this._renderService.dimensions.css.cell.height
    });
  }

  private _getChangeOptions(): ScrollableElementChangeOptions {
    return {
      mouseWheelScrollSensitivity: this._optionsService.rawOptions.scrollSensitivity,
      fastScrollSensitivity: this._optionsService.rawOptions.fastScrollSensitivity,
      verticalScrollbarSize: this._optionsService.rawOptions.overviewRulerWidth || ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH
    };
  }

  private _queueSync(ydisp?: number): void {
    // Update state
    if (ydisp !== undefined) {
      this._latestYDisp = ydisp;
    }

    // Don't queue more than one callback
    if (this._queuedAnimationFrame !== undefined) {
      return;
    }
    this._queuedAnimationFrame = this._renderService.addRefreshCallback(() => this._sync(this._latestYDisp));
    this._latestYDisp = undefined;
    this._queuedAnimationFrame = undefined;
  }

  private _sync(ydisp: number = this._bufferService.buffer.ydisp): void {
    if (!this._renderService || this._isSyncing) {
      return;
    }
    this._isSyncing = true;

    // Ignore any onScroll event that happens as a result of dimensions changing as this should
    // never cause a scrollLines call, only setScrollPosition can do that.
    this._suppressOnScrollHandler = true;
    this._scrollableElement.setScrollDimensions({
      height: this._renderService.dimensions.css.canvas.height,
      scrollHeight: this._renderService.dimensions.css.cell.height * this._bufferService.buffer.lines.length
    });
    this._suppressOnScrollHandler = false;

    // If ydisp has been changed by some other copmonent (input/buffer), then stop animating smooth
    // scroll and scroll there immediately.
    if (ydisp !== this._latestYDisp) {
      this._scrollableElement.setScrollPosition({
        scrollTop: ydisp * this._renderService.dimensions.css.cell.height
      });
    }

    this._isSyncing = false;
  }

  private _handleScroll(e: ScrollEvent): void {
    if (!this._renderService) {
      return;
    }
    if (this._isHandlingScroll || this._suppressOnScrollHandler) {
      return;
    }
    this._isHandlingScroll = true;
    const newRow = Math.round(e.scrollTop / this._renderService.dimensions.css.cell.height);
    const diff = newRow - this._bufferService.buffer.ydisp;
    if (diff !== 0) {
      this._latestYDisp = newRow;
      this._onRequestScrollLines.fire(diff);
    }
    this._isHandlingScroll = false;
  }
}
