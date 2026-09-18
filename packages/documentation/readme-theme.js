import { DefaultTheme, JSX } from 'typedoc';

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
}
