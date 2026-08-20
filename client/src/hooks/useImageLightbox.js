import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Makes every image inside a container openable.
 *
 * A delegated listener on the container rather than props on each image, because the images are
 * inside content the editor owns: TipTap renders the DOM for `<figure><img><figcaption>` and
 * nothing React holds a reference to. One listener also means every image in the container is
 * covered — pasted evidence, a replaced screenshot, an image inside a table cell — without
 * anything having to be wired up per case.
 *
 * The caption comes from the `figcaption` beside the image when there is one, so the lightbox
 * shows what the report will print rather than the uploader's file name.
 */
export function useImageLightbox(containerRef, { enabled = true, trigger = 'click' } = {}) {
  const [state, setState] = useState(null);
  const latest = useRef(null);

  /** Every image in the container, in document order, so next/previous means what it looks like. */
  const collect = useCallback(() => {
    const root = containerRef.current;
    if (!root) return [];
    return [...root.querySelectorAll('img')]
      .filter((img) => img.getAttribute('src'))
      .map((img) => ({
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt') ?? '',
        caption:
          img.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ||
          img.getAttribute('data-caption') ||
          '',
        node: img,
      }));
  }, [containerRef]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !enabled) return undefined;

    const open = (event) => {
      const img = event.target instanceof Element ? event.target.closest('img') : null;
      if (!img || !root.contains(img)) return;
      const images = collect();
      const index = images.findIndex((entry) => entry.node === img);
      if (index === -1) return;
      /*
       * Only for a plain activation. A modified click is somebody opening the image in a tab, and
       * in the editor a plain click has to keep selecting the node so the caption field and the
       * replace button still work — which is why the editor asks for `dblclick`.
       */
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setState({ images: images.map(({ node: _node, ...rest }) => rest), index });
    };

    root.addEventListener(trigger, open);
    return () => root.removeEventListener(trigger, open);
  }, [containerRef, enabled, trigger, collect]);

  latest.current = state;

  return {
    /** Props for `<Lightbox {...lightbox.props} />`, or null when nothing is open. */
    props: state
      ? {
          images: state.images,
          index: state.index,
          onClose: () => setState(null),
          onIndex: (index) => setState((current) => (current ? { ...current, index } : current)),
        }
      : null,
    /** For opening it from a button rather than from a click on the image itself. */
    openAt: (index) => setState({ images: collect().map(({ node: _n, ...rest }) => rest), index }),
    /**
     * Opens whichever image has this `src`.
     *
     * What a toolbar button needs: the editor knows which node is selected but not where it sits
     * among the images in the document, and the src is the one thing both ends agree on.
     */
    openBySrc: (src) => {
      const images = collect();
      const index = images.findIndex((entry) => entry.src === src);
      if (index === -1) return;
      setState({ images: images.map(({ node: _n, ...rest }) => rest), index });
    },
    close: () => setState(null),
  };
}

export default useImageLightbox;
