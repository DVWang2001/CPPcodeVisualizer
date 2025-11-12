/*
Animations.tsx就是用來給我弄視覺化的
*/

import React from "react";
import { global_variable } from "./global_variable";

class Visualizer extends React.Component {
  updateInterval: any;
  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    
  }
  static clear() {
    if ("__guide" in global_variable) {
      (global_variable as any).__guide.clear();
    }
    if ("__hasLeadingT" in global_variable) {
      delete (global_variable as any).__hasLeadingT;
    }
  }
  renderGuideTable() {
    const guide = (global_variable as any).__guide as Map<string, any[]>;
    if (!guide || guide.size === 0) {
      return <div>No guide data available</div>;
    }
    const hasLeadingT = (global_variable as any).__hasLeadingT;
    if (hasLeadingT) {
      // 水平表格：表頭是變數名，下面多行是歷史值，每增長一次就多一行
      const headers = Array.from(guide.keys()).map(key => (
        <th key={key} style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{key}</th>
      ));
      const maxValues = Math.max(...Array.from(guide.values()).map(v => v.length));
      const rows = [];
      for (let i = 0; i < maxValues; i++) {
        const cells = Array.from(guide.values()).map((values, index) => (
          <td key={index} style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{values[i] || ''}</td>
        ));
        rows.push(<tr key={i}>{cells}</tr>);
      }
      return (
        <table style={{ width: '100%', border: '1px solid black', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{headers}</tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      );
    } else {
      // 原來的水平表格
      const maxValues = Math.max(...Array.from(guide.values()).map(v => v.length));
      const rows = Array.from(guide.entries()).map(([key, values]) => {
        const cells = [<td key="expr" style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{key}</td>];
        for (let i = 0; i < maxValues; i++) {
          cells.push(<td key={i} style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{values[i] || ''}</td>);
        }
        return <tr key={key}>{cells}</tr>;
      });
      return (
        <table style={{ width: '100%', border: '1px solid black', borderCollapse: 'collapse' }}>
          <tbody>{rows}</tbody>
        </table>
      );
    }
  }
  render() {
    return this.renderGuideTable();
  }
  componentDidMount() {
    this.updateInterval = setInterval(() => this.forceUpdate(), 1000);
  }
  componentWillUnmount() {
    if (this.updateInterval) clearInterval(this.updateInterval);
  }
}
export default Visualizer;