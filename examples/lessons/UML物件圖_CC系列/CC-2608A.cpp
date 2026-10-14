// UML 物件圖教案 CC-2608A：點集合（轉成單一 Point 與總長度；轉型運算子改成具名函式）
// （改寫自 CF 題目 CC-2608A：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
#include<cmath>
using namespace std;
class Point{
   double m_x,m_y;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point add(const Point& b)const{return Point(m_x+b.m_x,m_y+b.m_y);}
   Point div(double b)const{return Point(m_x/b,m_y/b);}
   double toDouble()const{return sqrt(m_x*m_x+m_y*m_y);}
   void read(){cin>>m_x>>m_y;}
   void print()const{cout<<"("<<m_x<<","<<m_y<<")";}
};
class PVec{
   vector<Point> m_pts;
public:
   PVec(int n):m_pts(n){}
   int size()const{return m_pts.size();}
   Point sum()const{
      Point s;
      for(int k=0;k<m_pts.size();k++) s=s.add(m_pts[k]);
      return s;
   }
   Point avg()const{
      return sum().div(m_pts.size());
   }
   Point toPoint()const{return avg();}
   double toDouble()const{
      double s=0;
      for(int k=0;k<m_pts.size();k++) s+=m_pts[k].toDouble();
      return s;
   }
   void read(){for(int k=0;k<m_pts.size();k++) m_pts[k].read();}
   void print()const{
      cout<<"sum:";sum().print();cout<<endl;
      cout<<"avg:";avg().print();cout<<endl;
   }
};
int main(){
   int n;cin>>n;
   PVec pts(n);pts.read();
   pts.print();cout<<endl;//第一行 PVec  //@ @guide uml:pts
   Point G=pts.toPoint();G.print();cout<<endl;//第二行 Point
   cout<<pts.size()<<endl;//第三行 點的個數
   cout<<pts.toDouble()<<endl;//第四行 轉換為 double
   return 0;
}
