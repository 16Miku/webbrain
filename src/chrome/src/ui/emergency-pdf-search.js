export function createEmergencyPdfTextSearch() {
  let latestSearchId = 0;

  return {
    async find(query, options = {}) {
      const id = ++latestSearchId;
      const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
      const lastPage = Math.max(0, Math.floor(Number(options.numPages) || 0));
      if (!normalizedQuery || !lastPage || typeof options.pageText !== 'function') {
        return { id, query: normalizedQuery, page: 0 };
      }
      const currentPage = Math.max(1, Math.min(lastPage, Math.floor(Number(options.pageNumber) || 1)));
      const order = [];
      for (let page = currentPage + 1; page <= lastPage; page += 1) order.push(page);
      for (let page = 1; page <= currentPage; page += 1) order.push(page);

      try {
        for (const page of order) {
          const text = await options.pageText(page);
          if (id !== latestSearchId) return { id, query: normalizedQuery, page: 0 };
          if (String(text || '').toLocaleLowerCase().includes(normalizedQuery)) {
            return { id, query: normalizedQuery, page };
          }
        }
      } catch (error) {
        if (id !== latestSearchId) return { id, query: normalizedQuery, page: 0 };
        return { id, query: normalizedQuery, page: 0, error };
      }
      return { id, query: normalizedQuery, page: 0 };
    },
    async apply(result, action) {
      const isCurrent = () => Number.isInteger(result?.id) && result.id === latestSearchId;
      if (!isCurrent() || typeof action !== 'function') return false;
      try {
        const applied = await action(isCurrent);
        if (applied === false) return false;
      } catch (error) {
        if (!isCurrent()) return false;
        throw error;
      }
      return isCurrent();
    },
    isCurrent(result) {
      return Number.isInteger(result?.id) && result.id === latestSearchId;
    },
    cancel() {
      latestSearchId += 1;
    },
  };
}
