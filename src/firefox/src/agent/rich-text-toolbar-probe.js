import { frameHostMatches } from './permission-gate.js';
import { richTextToolbarUsesFocusedTarget } from './rich-text-toolbar-guard.js';

function secureRandomBase36Token(length = 8) {
  const size = Math.max(1, Math.floor(Number(length) || 0));
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += (byte % 36).toString(36);
  return out;
}

function withDispatchBinding(probe, frameId = probe?.frameId) {
  if (!probe || typeof probe !== 'object') return probe;
  const token = String(probe.dispatchBinding?.token || '');
  const backendNodeId = Number(probe.dispatchBinding?.backendNodeId) || null;
  const dispatchBinding = token || backendNodeId
    ? {
        ...(token ? { token } : {}),
        ...(backendNodeId ? { backendNodeId } : {}),
        ...(Number.isInteger(frameId) ? { frameId } : {}),
      }
    : null;
  return {
    ...probe,
    ...(dispatchBinding ? { dispatchBinding } : {}),
  };
}

export class RichTextToolbarProbe {
  constructor(agent) {
    this.agent = agent;
  }

  async frameGeometryToTop(tabId, navigationFrames, frameId, rect) {
    if (!rect || !Number.isInteger(frameId)) return null;
    if (frameId === 0) return { annotationRect: rect, frameOwnerRect: null, frameOwnerMeta: null };
    const frames = Array.isArray(navigationFrames) ? navigationFrames : [];
    if (!frames.some(frame => frame?.frameId === 0) || !frames.some(frame => frame?.frameId === frameId)) return null;
    const snapshots = (await Promise.all(frames.map(async frame => {
      const collect = () => browser.tabs.sendMessage(tabId, {
        target: 'redaction-content',
        action: 'get_redaction_regions',
        params: { coordinateSpace: 'viewport' },
      }, { frameId: frame.frameId });
      let payload;
      try {
        payload = await collect();
      } catch {
        try {
          await browser.tabs.executeScript(tabId, {
            frameId: frame.frameId,
            file: 'src/content/redaction-regions.js',
          });
          payload = await collect();
        } catch {
          return null;
        }
      }
      return {
        ...payload,
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url || '',
      };
    }))).filter(Boolean);
    const navigationById = new Map(frames.map(frame => [frame.frameId, frame]));
    const snapshotById = new Map(snapshots.map(frame => [frame.frameId, frame]));
    const edges = [];
    const seen = new Set();
    let child = navigationById.get(frameId);
    while (child && child.frameId !== 0 && !seen.has(child.frameId)) {
      seen.add(child.frameId);
      const parent = navigationById.get(child.parentFrameId);
      if (!parent) return null;
      edges.unshift({ parent, child });
      child = parent;
    }
    if (!child || child.frameId !== 0) return null;
    const exactChildRect = async edge => {
      const token = `wb-frame-${Date.now()}-${secureRandomBase36Token(12)}`;
      const parentResponse = browser.tabs.sendMessage(tabId, {
        target: 'redaction-content',
        action: 'wait_for_exact_child_frame_rect',
        params: { token, scrollIntoView: true },
      }, { frameId: edge.parent.frameId }).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        await browser.tabs.sendMessage(tabId, {
          target: 'redaction-content',
          action: 'announce_exact_child_frame',
          params: { token },
        }, { frameId: edge.child.frameId });
      } catch {}
      return parentResponse;
    };
    const transforms = new Map([[0, { x: 0, y: 0, scaleX: 1, scaleY: 1 }]]);
    let frameOwnerRect = null;
    let frameOwnerMeta = null;
    for (const edge of edges) {
      const exact = await exactChildRect(edge);
      const parentTransform = transforms.get(edge.parent.frameId);
      const childSnapshot = snapshotById.get(edge.child.frameId);
      const childWidth = Number(childSnapshot?.viewport?.width);
      const childHeight = Number(childSnapshot?.viewport?.height);
      const content = exact?.contentRect;
      const outer = exact?.outerRect;
      if (
        !exact?.found || !parentTransform || !content || !outer
        || !(content.w > 0 && content.h > 0) || !(childWidth > 0 && childHeight > 0)
      ) return null;
      if (exact.scrolled) await new Promise(resolve => setTimeout(resolve, 50));
      const mappedContent = {
        x: parentTransform.x + content.x * parentTransform.scaleX,
        y: parentTransform.y + content.y * parentTransform.scaleY,
        w: content.w * parentTransform.scaleX,
        h: content.h * parentTransform.scaleY,
      };
      transforms.set(edge.child.frameId, {
        x: mappedContent.x,
        y: mappedContent.y,
        scaleX: mappedContent.w / childWidth,
        scaleY: mappedContent.h / childHeight,
      });
      if (edge.child.frameId === frameId) {
        const parentViewport = snapshotById.get(edge.parent.frameId)?.viewport || {};
        const ownerPageX = Number.isFinite(Number(outer.pageX))
          ? Number(outer.pageX)
          : Number(outer.x) + (Number(parentViewport.scrollX) || 0);
        const ownerPageY = Number.isFinite(Number(outer.pageY))
          ? Number(outer.pageY)
          : Number(outer.y) + (Number(parentViewport.scrollY) || 0);
        frameOwnerRect = { ...outer, pageX: ownerPageX, pageY: ownerPageY };
        frameOwnerMeta = exact.ownerMeta || null;
      }
    }
    const transform = transforms.get(frameId);
    if (!transform) return null;
    const mapped = {
      x: transform.x + Number(rect.x) * transform.scaleX,
      y: transform.y + Number(rect.y) * transform.scaleY,
      w: Number(rect.w) * transform.scaleX,
      h: Number(rect.h) * transform.scaleY,
    };
    if (![mapped.x, mapped.y, mapped.w, mapped.h].every(Number.isFinite)) return null;
    const rounded = value => {
      const result = {
        x: Math.round(value.x),
        y: Math.round(value.y),
        w: Math.round(value.w),
        h: Math.round(value.h),
      };
      if (Number.isFinite(Number(value.pageX))) result.pageX = Math.round(Number(value.pageX));
      if (Number.isFinite(Number(value.pageY))) result.pageY = Math.round(Number(value.pageY));
      return result;
    };
    return {
      annotationRect: rounded(mapped),
      frameOwnerRect: frameOwnerRect ? rounded(frameOwnerRect) : null,
      frameOwnerMeta,
    };
  }

  async frameRectToTop(tabId, navigationFrames, frameId, rect) {
    const geometry = await this.frameGeometryToTop(tabId, navigationFrames, frameId, rect);
    return geometry?.annotationRect || null;
  }

  async legacyIframeTypeAllFrames(tabId, { selector, text, clear, urlFilter }) {
    const code = `
      (() => {
        const filter = ${JSON.stringify(urlFilter || '')};
        if (filter) {
          let wanted = String(filter).toLowerCase().trim();
          try { wanted = new URL(/^[a-z][a-z0-9+.\\-]*:\\/\\//i.test(wanted) ? wanted : 'https://' + wanted).hostname; } catch (error) {}
          wanted = wanted.replace(/^www\\./, '');
          const host = location.hostname.toLowerCase().replace(/^www\\./, '');
          const hostOk = !wanted || host === wanted || host.endsWith('.' + wanted);
          if (!hostOk || !location.href.includes(filter)) return { ok: false, skipped: 'url-filter', url: location.href };
        }
        let targetDispatched = false;
        try {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, url: location.href, reason: 'not-found' };
          targetDispatched = true;
          el.focus();
          if (el.isContentEditable) {
            if (${!!clear}) el.textContent = '';
            el.textContent += ${JSON.stringify(text)};
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
            return { ok: true, url: location.href, method: 'contenteditable', value: el.textContent.slice(0, 100), dispatched: true };
          }
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const newValue = (${!!clear} ? '' : (el.value || '')) + ${JSON.stringify(text)};
          if (setter) setter.call(el, newValue); else el.value = newValue;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, url: location.href, method: 'native-setter', value: (el.value || '').slice(0, 100), dispatched: true };
        } catch (error) {
          return { ok: false, url: location.href, dispatched: targetDispatched, error: error.message };
        }
      })()
    `;
    const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
    const successes = (results || []).filter(result => result && result.ok);
    if (successes.length > 0) {
      return { success: true, dispatched: true, frame: successes[0], resolution: 'all-frames' };
    }
    const candidates = (results || []).filter(result => result && !result.skipped);
    const targetDispatched = candidates.some(candidate => candidate.dispatched === true);
    return {
      success: false,
      ...(targetDispatched ? { dispatched: true } : { dispatched: false, noDispatch: true }),
      error: 'Input not found in any matching iframe',
      searchedFrames: candidates.length,
      frameUrls: candidates.map(candidate => candidate.url).slice(0, 5),
    };
  }

  async _requestFrameProbe(tabId, frame, params) {
    const request = () => browser.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'probe_rich_text_toolbar_retry_target',
      params,
    }, { frameId: frame.frameId });
    let probe;
    try {
      probe = await request();
    } catch {
      try {
        await browser.tabs.executeScript(tabId, {
          frameId: frame.frameId,
          file: 'src/content/rich-text-toolbar-heuristic.js',
        });
        await browser.tabs.executeScript(tabId, {
          frameId: frame.frameId,
          file: 'src/content/accessibility-tree.js',
        });
        await browser.tabs.executeScript(tabId, {
          frameId: frame.frameId,
          file: 'src/content/content.js',
        });
        probe = await request();
      } catch {
        return null;
      }
    }
    return probe?.resolved ? withDispatchBinding({
      ...probe,
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      frameUrl: frame.url || '',
    }, frame.frameId) : null;
  }

  async probeIframeTarget(tabId, args = {}, { mapAnnotation = true } = {}) {
    const selector = typeof args?.selector === 'string' ? args.selector.trim() : '';
    if (!selector) return null;
    let navigationFrames;
    try { navigationFrames = await browser.webNavigation.getAllFrames({ tabId }); } catch { return null; }
    if (!Array.isArray(navigationFrames) || !navigationFrames.length) return null;
    const urlFilter = String(args?.urlFilter || '');
    const matchingFrames = navigationFrames.filter(frame => {
      const url = String(frame?.url || '');
      return frame?.frameId !== 0
        && (!urlFilter || (frameHostMatches(url, urlFilter) && url.includes(urlFilter)));
    });
    const probes = (await Promise.all(matchingFrames.map(frame => this._requestFrameProbe(tabId, frame, {
      toolName: 'type_text',
      args: { selector, text: args?.text || '' },
    })))).filter(Boolean);
    if (!probes.length) return null;
    if (probes.length !== 1) {
      await Promise.all(probes.map(probe => this.release(tabId, probe)));
      return {
        resolved: false,
        ambiguous: true,
        matchCount: probes.length,
        matchedFrameIds: probes.map(probe => probe.frameId),
        matchedFrameUrls: probes.map(probe => probe.frameUrl || '').filter(Boolean).slice(0, 5),
      };
    }
    const selected = probes[0];
    const recoveryNeedsGeometry = this.agent._richTextToolbarGuard.needsFrameOwnerGeometry(tabId);
    const candidateNeedsAnnotation = Number(selected.fieldMeta?.toolbarCandidate?.score) >= 4;
    const geometry = mapAnnotation && (candidateNeedsAnnotation || recoveryNeedsGeometry)
      ? await this.frameGeometryToTop(tabId, navigationFrames, selected.frameId, selected.rect)
      : null;
    return withDispatchBinding({
      ...selected,
      annotationRect: mapAnnotation ? geometry?.annotationRect || null : null,
      frameOwnerRect: geometry?.frameOwnerRect || null,
      frameOwnerMeta: geometry?.frameOwnerMeta || null,
      frameOwnerScopeUrl: navigationFrames.find(frame => frame?.frameId === selected.parentFrameId)?.url || '',
      topFrameUrl: navigationFrames.find(frame => frame?.frameId === 0)?.url || '',
    }, selected.frameId);
  }

  async probeFocusedTarget(tabId, args = {}, { mapAnnotation = false } = {}) {
    let navigationFrames;
    try { navigationFrames = await browser.webNavigation.getAllFrames({ tabId }); } catch { return null; }
    if (!Array.isArray(navigationFrames) || !navigationFrames.length) return null;
    const focusedChildFrame = async (parentFrameId, children) => {
      for (const child of children) {
        const token = `wb-focused-frame-${Date.now()}-${secureRandomBase36Token(12)}`;
        const parentResponse = browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'wait_for_rich_text_toolbar_focused_child_frame',
          params: { token },
        }, { frameId: parentFrameId }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 0));
        const announce = () => browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'announce_rich_text_toolbar_focused_child_frame',
          params: { token },
        }, { frameId: child.frameId });
        try {
          await announce();
        } catch {
          try {
            await browser.tabs.executeScript(tabId, {
              frameId: child.frameId,
              file: 'src/content/rich-text-toolbar-heuristic.js',
            });
            await browser.tabs.executeScript(tabId, {
              frameId: child.frameId,
              file: 'src/content/accessibility-tree.js',
            });
            await browser.tabs.executeScript(tabId, {
              frameId: child.frameId,
              file: 'src/content/content.js',
            });
            await announce();
          } catch {}
        }
        const match = await parentResponse;
        if (match?.matched === true) return child;
      }
      return null;
    };
    const topFrame = navigationFrames.find(frame => frame?.frameId === 0);
    if (!topFrame) return null;
    let selected = await this._requestFrameProbe(tabId, topFrame, {
      toolName: 'type_text',
      args: { text: args?.text || '' },
    });
    if (!selected) return null;
    const seen = new Set();
    while (['iframe', 'frame'].includes(String(selected.fieldMeta?.tag || '').toLowerCase())) {
      if (seen.has(selected.frameId)) break;
      seen.add(selected.frameId);
      const children = navigationFrames.filter(frame => frame?.parentFrameId === selected.frameId);
      if (!children.length) break;
      const child = await focusedChildFrame(selected.frameId, children);
      if (!child) break;
      const nextSelected = await this._requestFrameProbe(tabId, child, {
        toolName: 'type_text',
        args: { text: args?.text || '' },
      });
      if (!nextSelected) break;
      selected = nextSelected;
    }
    const annotationRect = mapAnnotation
      ? await this.frameRectToTop(tabId, navigationFrames, selected.frameId, selected.rect)
      : null;
    return withDispatchBinding({ ...selected, annotationRect }, selected.frameId);
  }

  async release(tabId, probeOrBinding) {
    const binding = probeOrBinding?.dispatchBinding || probeOrBinding;
    const token = String(binding?.token || '');
    if (!token) return;
    const options = Number.isInteger(binding?.frameId) ? { frameId: binding.frameId } : undefined;
    try {
      await browser.tabs.sendMessage(tabId, {
        target: 'content',
        action: 'release_dispatch_binding',
        params: { dispatchBinding: { token } },
      }, options);
    } catch {}
  }

  async probe(tabId, toolName, args = {}, { mapAnnotation = false } = {}) {
    if (toolName === 'iframe_type' || toolName === 'iframe_click') {
      return this.probeIframeTarget(tabId, args, { mapAnnotation: false });
    }
    if (richTextToolbarUsesFocusedTarget(toolName, args)) {
      return this.probeFocusedTarget(tabId, args, { mapAnnotation });
    }
    try {
      const probe = await browser.tabs.sendMessage(tabId, {
        target: 'content',
        action: 'probe_rich_text_toolbar_retry_target',
        params: { toolName, args },
      });
      return withDispatchBinding(probe, 0);
    } catch {
      try {
        await this.agent._injectCoreContentScripts(tabId);
        const probe = await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'probe_rich_text_toolbar_retry_target',
          params: { toolName, args },
        });
        return withDispatchBinding(probe, 0);
      } catch {
        return null;
      }
    }
  }
}
