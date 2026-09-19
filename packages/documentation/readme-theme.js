import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { DefaultTheme, JSX, RendererEvent } from 'typedoc';

// TypeDoc renders the README at index.html, but its sidebar project link opens
// modules.html. Include the same README there, above the generated API index.
class ReadmeTheme extends DefaultTheme {
  constructor(renderer) {
    super(renderer);
    const reflectionTemplate = this.reflectionTemplate;
    this.reflectionTemplate = page => JSX.createElement(
      JSX.Fragment,
      null,
      page.model.isProject() ? this.getRenderContext(page).indexTemplate(page) : null,
      reflectionTemplate(page),
    );
  }
}

export function load(app) {
  app.renderer.defineTheme('readme-overview', ReadmeTheme);
  app.renderer.on(RendererEvent.BEGIN, () => {
    app.renderer.postRenderAsyncJobs.push(event => copyFile(
      new URL('../../assets/og-image.jpg', import.meta.url),
      path.join(event.outputDirectory, 'og-image.jpg'),
    ));
  });
  // Emit previews in every page's HTML so crawlers do not need JavaScript.
  app.renderer.hooks.on('head.end', context => {
    const { page } = context;
    const base = context.options.getValue('hostedBaseUrl');
    const url = new URL(page.url === 'index.html' ? './' : page.url, base).href;
    const title = page.model.isProject() ? page.project.name : `${page.model.name} | ${page.project.name}`;
    const description = 'API reference and guides for valhalla-browser, the TypeScript SDK for local driving, cycling, walking and truck routing with Valhalla WebAssembly.';
    const image = new URL('og-image.jpg', base).href;
    const alt = 'A blue route across a riverside city, connecting green and red map pins.';
    const properties = {
      'og:type': 'website', 'og:site_name': page.project.name,
      'og:title': title, 'og:description': description, 'og:url': url,
      'og:image': image, 'og:image:type': 'image/jpeg',
      'og:image:width': '1200', 'og:image:height': '631', 'og:image:alt': alt,
    };
    const names = {
      'twitter:card': 'summary_large_image', 'twitter:title': title,
      'twitter:description': description, 'twitter:image': image, 'twitter:image:alt': alt,
    };
    return JSX.createElement(JSX.Fragment, null,
      // TypeDoc already emits the homepage canonical link with hostedBaseUrl.
      page.url !== 'index.html' ? JSX.createElement('link', { rel: 'canonical', href: url }) : null,
      ...Object.entries(properties).map(([property, content]) => JSX.createElement('meta', { property, content })),
      ...Object.entries(names).map(([name, content]) => JSX.createElement('meta', { name, content })),
    );
  });
}
