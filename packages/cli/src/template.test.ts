import { describe, it, expect } from "vitest";
import type { Graph } from "@dbt-open-lineage/core";
import { buildHtml } from "./template";

const graph: Graph = { nodes: [], edges: [] };

describe("buildHtml", () => {
  it("embeds the graph data as window.__DOL_STATIC_DATA__", () => {
    const html = buildHtml({ graph, sidecarText: null });
    expect(html).toContain("window.__DOL_STATIC_DATA__=");
    expect(html).toContain('"nodes":[]');
  });

  it("references the built JS and CSS assets by relative path", () => {
    const html = buildHtml({ graph, sidecarText: null });
    expect(html).toContain('src="./assets/main.js"');
    expect(html).toContain('href="./assets/main.css"');
  });

  it("escapes < in embedded JSON so a </script>-like string can't break out", () => {
    const html = buildHtml({ graph, sidecarText: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("defaults the title, or uses and HTML-escapes a provided one", () => {
    expect(buildHtml({ graph, sidecarText: null })).toContain("<title>dbt Lineage</title>");
    const html = buildHtml({ graph, sidecarText: null, title: "<b>My Proj</b> & Co" });
    expect(html).toContain("<title>&lt;b&gt;My Proj&lt;/b&gt; &amp; Co</title>");
  });
});
