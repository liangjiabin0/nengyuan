model BatterySOC
  parameter Modelica.Units.SI.Energy E_nom = 100 * 3.6e6 "Nominal energy";
  parameter Real SOC_start(min=0, max=1) = 0.8 "Initial state of charge";
  parameter Modelica.Units.SI.Power P = 20e3 "Positive means discharge";
  Real SOC(min=0, max=1) "State of charge";
initial equation
  SOC = SOC_start;
equation
  der(SOC) = -P / E_nom;
  annotation(experiment(StartTime=0, StopTime=3600, Tolerance=1e-6, Interval=3.6));
end BatterySOC;
