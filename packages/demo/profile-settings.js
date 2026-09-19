// Blank controls leave values unset so defaults come from the pinned engine.
const fields = {
  auto: [],
  bicycle: [
    ['bicycle_type', 'Bicycle type', ['hybrid', 'road', 'cross', 'mountain'], 'hybrid'],
    ['cycling_speed', 'Cycling speed (km/h)', [5, 60], '18 hybrid · 25 road · 20 cross · 16 mountain'],
    ['use_roads', 'Road preference (0–1)', [0, 1], '0.25'],
  ],
  pedestrian: [['walking_speed', 'Walking speed (km/h)', [0.5, 25], '5.1']],
  truck: [
    ['height', 'Height (m)', [0, 10], '4.11'], ['width', 'Width (m)', [0, 10], '2.6'],
    ['length', 'Length (m)', [0, 50], '21.64'], ['weight', 'Total weight (metric tonnes)', [0, 100], '21.77'],
    ['axle_load', 'Axle load (metric tonnes)', [0, 40], '9.07'], ['hazmat', 'Hazardous goods', ['false', 'true'], 'false'],
  ],
};
export function profileSettings(select, container, details, reset, changed) {
  const values = {};
  function render() {
    const profile = select.value;
    container.replaceChildren();
    details.hidden = profile === 'auto';
    for (const [key, title, allowed, fallback] of fields[profile]) {
      const label = document.createElement('label'); label.textContent = `${title} · default ${fallback}`;
      const control = document.createElement(typeof allowed[0] === 'number' ? 'input' : 'select');
      control.name = key;
      if (control.tagName === 'INPUT') {
        control.type = 'number'; control.min = allowed[0]; control.max = allowed[1]; control.step = 'any';
        control.placeholder = 'Default';
      } else {
        control.add(new Option('Default', ''));
        for (const value of allowed) control.add(new Option(value, value));
      }
      control.value = values[profile]?.[key] ?? '';
      control.oninput = () => { (values[profile] ??= {})[key] = control.value; changed(); };
      label.append(control); container.append(label);
    }
  }
  select.onchange = () => { render(); changed(); };
  reset.onclick = () => { delete values[select.value]; render(); changed(); };
  render();
  return {
    request() {
      const costing = select.value;
      const options = {};
      for (const [key, value] of Object.entries(values[costing] ?? {})) if (value !== '')
        options[key] = key === 'bicycle_type' ? value : key === 'hazmat' ? value === 'true' : Number(value);
      return { costing, ...(Object.keys(options).length ? { costing_options: { [costing]: options } } : {}) };
    },
    capabilities(costings) { for (const option of select.options) option.disabled = !!costings && !costings.includes(option.value); },
    busy(value) { select.disabled = value; container.disabled = value; reset.disabled = value; },
  };
}
