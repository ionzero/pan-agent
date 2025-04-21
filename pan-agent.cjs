
module.exports.loadPanAgent = async function () {
  const mod = await import('./pan-agent.mjs');
  return {
    PanAgent: mod.PanAgent,
    PanGroup: mod.PanGroup
  };
};
