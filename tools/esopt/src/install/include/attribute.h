#pragma once

enum class ModelAttributeDouble
{
    DualObjectiveValue,
    ObjectiveBound,
    ObjectiveValue,
    SolveTimeSec,
    RelativeGap,
    TimeLimitSec,
    
};

enum class ModelAttributeInt
{
    ObjectiveSense,
    BarrierIterations,
    NodeCount,
    SimplexIterations,
    NumberOfThreads,
    TerminationStatus,
    Silent,

};

enum class ModelAttributeString
{
    Name,
    SolverName,
    SolverVersion,

};

enum class VariableAttributeDouble
{
    Value,
    LowerBound,
    UpperBound,
    PrimalStart,
};

enum class VariableAttributeInt
{
    IISLowerBound,
    IISUpperBound,

};

enum class VariableAttributeString
{
    Domain,
    Name,

};

enum class ConstraintAttributeDouble
{
    Primal,
    Dual,
};

enum class ConstraintAttributeInt
{
    IIS,
};

enum class ConstraintAttributeString
{
    Name,
};