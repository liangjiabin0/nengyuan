#pragma once
#include <string>

#include "variable_expression.h"
#include "constraint.h"
#include "attribute.h"


class MODEL_API ModelBase
{
  public:
	virtual ~ModelBase() = default;

	// 添加变量
	virtual VariableIndex add_variable(double lb, double ub, VariableDomain domain = VariableDomain::Continuous,
	                                   const char *name = nullptr) = 0;

	// 添加线性约束
	virtual ConstraintIndex add_linear_constraint(const ScalarAffineFunction &f, ConstraintSense sense, double rhs,
	                                              const char *name = nullptr) = 0;

	// 设置目标函数
	virtual void set_objective(const ScalarAffineFunction &expr, ObjectiveSense sense = ObjectiveSense::Minimize) = 0;

	// 求解优化模型
	virtual void optimize() = 0;

	// 设置变量上下界
	virtual void set_variable_bounds(const VariableIndex &variable, double lb, double ub) = 0;
	// 获取变量值
	virtual double get_variable_value(const VariableIndex &variable) = 0;
	
	// 获取和设置属性
	virtual bool supports_model_attribute(ModelAttributeDouble attribute, bool changeable) = 0;
	virtual bool supports_model_attribute(ModelAttributeInt attribute, bool changeable) = 0;
	virtual bool supports_model_attribute(ModelAttributeString attribute, bool changeable) = 0;
	virtual double get_model_attribute(ModelAttributeDouble attribute) = 0;
	virtual int get_model_attribute(ModelAttributeInt attribute) = 0;
	virtual std::string get_model_attribute(ModelAttributeString attribute) = 0;
	virtual void set_model_attribute(ModelAttributeDouble attribute, double value) = 0;
	virtual void set_model_attribute(ModelAttributeInt attribute, int value) = 0;
	virtual void set_model_attribute(ModelAttributeString attribute, const char *value) = 0;

	// 变量和约束的属性的接口类似，待添加
	virtual bool supports_variable_attribute(VariableAttributeDouble attribute, bool changeable) = 0;
	virtual bool supports_variable_attribute(VariableAttributeInt attribute, bool changeable) = 0;
	virtual bool supports_variable_attribute(VariableAttributeString attribute, bool changeable) = 0;
	virtual double get_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute) = 0;
	virtual int get_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute) = 0;
	virtual std::string get_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute) = 0;
	virtual void set_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute, double value) = 0;
	virtual void set_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute, int value) = 0;
	virtual void set_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute, const char *value) = 0;

	virtual bool supports_constraint_attribute(ConstraintAttributeDouble attribute, bool changeable) = 0;
	virtual bool supports_constraint_attribute(ConstraintAttributeInt attribute, bool changeable) = 0;
	virtual bool supports_constraint_attribute(ConstraintAttributeString attribute, bool changeable) = 0;
	virtual double get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeDouble attribute) = 0;
	virtual int get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeInt attribute) = 0;
	virtual std::string get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeString attribute) = 0;
	virtual void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeDouble attribute, double value) = 0;
	virtual void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeInt attribute, int value) = 0;
	virtual void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeString attribute, const char *value) = 0;
	
	// 设置求解器参数
	virtual void set_parameter(const char *name, double value) = 0;
	virtual void set_parameter(const char *name, int value) = 0;
	virtual void set_parameter(const char *name, const char *value) = 0;
};