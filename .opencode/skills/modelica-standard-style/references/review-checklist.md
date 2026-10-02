# Modelica Review Checklist

- [ ] Uses standard-library connectors and `Modelica.Units.SI` where possible
- [ ] Physics lives in `equation`; initialization lives in `initial equation`
- [ ] No unexplained magic numbers; parameters have units and comments
- [ ] `annotation(experiment(...))` matches the intended horizon
- [ ] Edit stays inside the requested model/file
- [ ] No fabricated simulation numbers; results must come from the gateway
- [ ] `checkModel` messages are empty or explained
