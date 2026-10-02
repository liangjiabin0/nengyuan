#include "openTEPES.hpp"

#include <cstring>
#include <iostream>
#include <string>

#ifndef OPENTEPES_DEFAULT_DIR
#define OPENTEPES_DEFAULT_DIR "."
#endif

struct CaseSpec {
    const char* id;
    const char* title;
};

static const CaseSpec kCases[] = {
    {"case1", "湖南微电网"},
    {"case2", "河北微电网-变电站"},
    {"case3", "河北微电网-馈线"},
    {"case4", "河北微电网-台区"},
    {"case5", "冀北-电热耦合"},
    {"case6", "电算热耦合"},
};

static const CaseSpec* find_case(const std::string& key) {
    if (key.size() == 1 && key[0] >= '1' && key[0] <= '6') {
        return &kCases[key[0] - '1'];
    }
    for (const auto& c : kCases) {
        if (key == c.id || key == c.title) return &c;
    }
    return nullptr;
}

static void print_help() {
    std::cout << "openTEPES_esopt [--case case1|...|case6|1|...|6] [--dir PATH]\n"
                 "                [--solver gurobi] [--log Yes] [--lib gurobi.dll]\n\n"
                 "算例（数据在 <dir>/<case>/sSEP/）：\n";
    for (const auto& c : kCases)
        std::cout << "  " << c.id << "  " << c.title << "\n";
    std::cout << "\n示例：\n"
                 "  openTEPES_esopt.exe --case case1\n"
                 "  openTEPES_esopt.exe --case 6\n";
}

int main(int argc, char** argv) {
    std::string dir = OPENTEPES_DEFAULT_DIR;
    std::string casename = "case1";
    std::string solver = "gurobi";
    std::string log = "Yes";
    std::string lib_gurobi;

    for (int i = 1; i < argc; ++i) {
        if ((std::strcmp(argv[i], "--dir") == 0 || std::strcmp(argv[i], "--case-dir") == 0) && i + 1 < argc)
            dir = argv[++i];
        else if (std::strcmp(argv[i], "--case") == 0 && i + 1 < argc)
            casename = argv[++i];
        else if (std::strcmp(argv[i], "--solver") == 0 && i + 1 < argc)
            solver = argv[++i];
        else if (std::strcmp(argv[i], "--log") == 0 && i + 1 < argc)
            log = argv[++i];
        else if (std::strcmp(argv[i], "--lib") == 0 && i + 1 < argc)
            lib_gurobi = argv[++i];
        else if (std::strcmp(argv[i], "--help") == 0) {
            print_help();
            return 0;
        }
    }

    std::string title = casename;
    std::string inner = "sSEP";
    if (const CaseSpec* spec = find_case(casename)) {
        title = spec->title;
        char sep = (dir.empty() || dir.back() == '/' || dir.back() == '\\') ? '\0' : '/';
        dir = sep ? (dir + sep + spec->id) : (dir + spec->id);
        casename = inner;
    }

    if (lib_gurobi.empty()) {
        std::cerr << "Missing --lib <gurobi DLL>. Use the project-local run.cmd launcher.\n";
        return 2;
    }

    std::cout << "Case: " << title << "\n";
    std::cout << "Dir:  " << dir << "/" << casename << "\n";
    std::cout << "Solver: " << solver << "\n";
    openTEPES_run(dir, casename, solver, log, lib_gurobi);
    std::cout << "End of the run                ************\n";
    return 0;
}
