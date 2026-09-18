module.exports = ({ ghost = true, max = 4 } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Effort picker regression</title></head><body>
  <form>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button type="button" id="effort-control" aria-haspopup="menu" data-tone="neutral"
      aria-expanded="${ghost}" data-state="${ghost ? "open" : "closed"}">Model</button>
  </form>
  <div id="effort-menu" role="menu" data-testid="composer-intelligence-picker-content" hidden>
    <div data-model-reasoning-effort-slider style="width:252px;height:32px">
      <div role="menuitem" tabindex="0">
        <span role="slider" aria-hidden="true" tabindex="-1" aria-valuemin="0"
          aria-valuemax="${max}" aria-valuenow="3" style="display:block;width:28px;height:28px"></span>
      </div>
    </div>
    <div role="group" hidden>
      <div role="menuitemradio" aria-checked="false">Model one</div>
      <div role="menuitemradio" aria-checked="true">Model two</div>
      <div role="menuitemradio" aria-checked="false">Model three</div>
    </div>
  </div>
  <script>
    (() => {
    window.effortFixture = { clicks: 0, pointerdowns: 0, enters: 0, escapes: 0 };
    const control = document.querySelector('#effort-control');
    const menu = document.querySelector('#effort-menu');
    const openMenu = () => {
      menu.hidden = false;
      control.setAttribute('aria-controls', 'effort-menu');
      control.setAttribute('aria-expanded', 'true');
      control.setAttribute('data-state', 'open');
    };
    control.addEventListener('click', () => {
      window.effortFixture.clicks += 1;
      control.setAttribute('aria-expanded', 'true');
      control.setAttribute('data-state', 'open');
      if (!${ghost}) openMenu();
    });
    control.addEventListener('pointerdown', event => {
      window.effortFixture.pointerdowns += 1;
      if (!window.effortFixture.clicks || event.button !== 0 || !event.isPrimary) return;
      openMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        window.effortFixture.enters += 1;
        event.preventDefault();
      }
      if (event.key === 'Escape') {
        window.effortFixture.escapes += 1;
        menu.hidden = true;
        control.removeAttribute('aria-controls');
        control.setAttribute('aria-expanded', 'false');
        control.setAttribute('data-state', 'closed');
      }
    });
    })();
  </script>
</body></html>`;
