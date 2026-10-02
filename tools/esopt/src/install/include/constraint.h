#pragma once

#ifdef _WIN32
    #ifdef MODEL_EXPORTS
        #define MODEL_API __declspec(dllexport)
    #else
        #define MODEL_API __declspec(dllimport)
    #endif
#else
    #define MODEL_API __attribute__((visibility("default")))
#endif

enum class ConstraintType
{
	Linear,
	Quadratic,
	Nonlinear,
};

enum class ConstraintSense
{
	// <=
	LessEqual,
	// >=
	GreaterEqual,
	// ==
	Equal,
	// lb <= constraint <= ub
	Within
};

class ConstraintIndex
{
  public:
	ConstraintIndex() = default;
	ConstraintIndex(ConstraintType t, int i) : type(t), index(i)
	{
	}

  public:
	ConstraintType type;
	int index;
};

// Nonlinear constraint index with callback information
class MODEL_API NLConstraintIndex
{
  public:
	NLConstraintIndex() = default;
	NLConstraintIndex(int i) : index(i) {}

  public:
	int index;
};

enum class ObjectiveSense
{
	Minimize,
	Maximize
};