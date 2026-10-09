(() => {
  const search = document.querySelector("#story-search");
  if (search) {
    const cards = [...document.querySelectorAll(".story-card")];
    const noResults = document.querySelector("#no-results");
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      let visible = 0;
      cards.forEach(card => {
        const match = card.dataset.search.includes(query);
        card.hidden = !match;
        if (match) visible += 1;
      });
      noResults.hidden = visible > 0;
    });
  }

  const title = document.querySelector("#postTitle");
  const body = document.querySelector("#postBody");
  const titleCount = document.querySelector("#title-count");
  const bodyCount = document.querySelector("#body-count");
  if (title && titleCount) title.addEventListener("input", () => { titleCount.textContent = title.value.length; });
  if (body && bodyCount) body.addEventListener("input", () => { bodyCount.textContent = body.value.length.toLocaleString(); });

  document.querySelectorAll("form[data-confirm]").forEach(form => {
    form.addEventListener("submit", event => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });
})();
