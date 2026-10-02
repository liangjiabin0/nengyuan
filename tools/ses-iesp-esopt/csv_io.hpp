#pragma once
// Minimal CSV helpers for openTEPES ESOPT port.

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

inline std::string trim_csv(std::string s) {
    while (!s.empty() && (s.back() == '\r' || s.back() == ' ' || s.back() == '\t')) s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r')) ++i;
    if (!s.empty() && s[0] == '\xEF') {  // UTF-8 BOM
        if (s.size() >= 3 && (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF) i = 3;
    }
    return s.substr(i);
}

inline std::vector<std::string> split_csv(const std::string& line) {
    std::vector<std::string> out;
    std::string cur;
    bool inq = false;
    for (char c : line) {
        if (c == '"') {
            inq = !inq;
        } else if (c == ',' && !inq) {
            out.push_back(trim_csv(cur));
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    out.push_back(trim_csv(cur));
    return out;
}

struct CsvTable {
    std::vector<std::string> header;
    std::vector<std::vector<std::string>> rows;
    std::unordered_map<std::string, int> col;

    int ncol(const std::string& name) const {
        auto it = col.find(name);
        if (it == col.end()) return -1;
        return it->second;
    }
    const std::string& at(int r, const std::string& name) const {
        int c = ncol(name);
        if (c < 0 || r < 0 || r >= (int)rows.size() || c >= (int)rows[r].size()) {
            static const std::string empty;
            return empty;
        }
        return rows[r][c];
    }
    const std::string& at(int r, int c) const {
        static const std::string empty;
        if (r < 0 || r >= (int)rows.size() || c < 0 || c >= (int)rows[r].size()) return empty;
        return rows[r][c];
    }
};

inline bool file_exists(const std::string& p) {
    std::ifstream f(p);
    return (bool)f;
}

inline CsvTable read_csv(const std::string& path, bool has_header = true) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("Cannot open CSV: " + path);
    CsvTable t;
    std::string line;
    bool first = true;
    while (std::getline(f, line)) {
        if (line.empty()) continue;
        auto cells = split_csv(line);
        if (first && has_header) {
            t.header = cells;
            for (int i = 0; i < (int)cells.size(); ++i) t.col[cells[i]] = i;
            first = false;
            continue;
        }
        first = false;
        t.rows.push_back(std::move(cells));
    }
    return t;
}

inline double to_d(const std::string& s, double def = 0.0) {
    if (s.empty() || s == "nan" || s == "NaN" || s == "None") return def;
    try {
        return std::stod(s);
    } catch (...) {
        return def;
    }
}

inline int to_i(const std::string& s, int def = 0) {
    if (s.empty()) return def;
    try {
        return std::stoi(s);
    } catch (...) {
        return def;
    }
}

inline int yesno(const std::string& s) {
    if (s.empty() || s == "0" || s == "0.0" || s == "No" || s == "NO" || s == "no" || s == "N" || s == "n")
        return 0;
    if (s == "1" || s == "1.0" || s == "Yes" || s == "YES" || s == "yes" || s == "Y" || s == "y")
        return 1;
    return to_i(s, 0);
}
